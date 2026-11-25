"""Règles métier du logiciel de stocks La Maison Blanche (voir conventions dans stockdb.py)."""
import base64, hashlib, hmac, json, re, secrets
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import stockdb as D
from stockdb import rows, one, val, now, audit, SERVICES, STD_UNITS

OPEN_REQUEST = ("brouillon", "soumise", "a_corriger", "approuvee", "partiellement_payee")
PAY_MODES = ("especes", "cheque", "virement", "autre")
ISSUE_KINDS = {"sortie": "Sortie vers service", "retour_service": "Retour d'un service", "perte": "Perte / casse", "retour_fournisseur": "Retour fournisseur"}


class Err(Exception):
    def __init__(self, msg, status=400, code=None, extra=None):
        super().__init__(msg); self.status = status; self.code = code; self.extra = extra or {}


# ---------------------------------------------------------------- saisie
def dec(x, name, maxdp):
    if isinstance(x, bool) or x is None: raise Err(f"{name} : valeur manquante")
    s = str(x).strip().replace(" ", "").replace(" ", "").replace(",", ".")
    try: d = Decimal(s)
    except InvalidOperation: raise Err(f"{name} : nombre invalide")
    if not d.is_finite(): raise Err(f"{name} : nombre invalide")
    if -d.as_tuple().exponent > maxdp and d != d.quantize(Decimal(1).scaleb(-maxdp)): raise Err(f"{name} : {maxdp} décimales maximum")
    return d


def qty_milli(x, name="Quantité", allow_zero=False):
    d = dec(x, name, 3)
    if d < 0 or (d == 0 and not allow_zero) or d >= Decimal(10) ** 9: raise Err(f"{name} : doit être supérieure à 0")
    return d


def money(x, name="Montant", allow_zero=False):
    """DA (2 décimales max) -> centimes."""
    d = dec(x, name, 2)
    if d < 0 or (d == 0 and not allow_zero) or d >= Decimal(10) ** 11: raise Err(f"{name} : montant invalide")
    return int((d * 100).to_integral_value(ROUND_HALF_UP))


def text(d, k, maxlen=120, required=True, label=None):
    v = d.get(k)
    v = "" if v is None else str(v).strip()
    if required and not v: raise Err(f"{label or k} : champ obligatoire")
    if len(v) > maxlen: raise Err(f"{label or k} : {maxlen} caractères maximum")
    return v


def intid(d, k, label=None, required=True):
    v = d.get(k)
    if v in (None, "") and not required: return None
    try:
        i = int(str(v))
        if i <= 0 or str(i) != str(v).strip(): raise ValueError
        return i
    except (ValueError, TypeError): raise Err(f"{label or k} : identifiant invalide")


def day(d, k, label=None, required=True, default=None):
    v = d.get(k) or default
    if not v:
        if required: raise Err(f"{label or k} : date obligatoire")
        return None
    try: return date.fromisoformat(str(v)[:10]).isoformat()
    except ValueError: raise Err(f"{label or k} : date invalide")


def uid(d):
    v = d.get("client_uid")
    if v is None: return None
    v = str(v)
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,64}", v): raise Err("Identifiant de saisie invalide")
    return v


def number_key(s):
    s = re.sub(r"[^0-9A-Z]", "", s.upper())
    return re.sub(r"(?<!\d)0+(?=\d)", "", s)


def need(u, role):
    if u["role"] != role:
        raise Err("Réservé à la direction" if role == "direction" else "Réservé au magasinier", 403)


def existing(c, table, cu):
    if cu:
        r = one(c, f"SELECT id FROM {table} WHERE client_uid=?", (cu,))
        if r: return {"id": r["id"], "deja_enregistre": True}
    return None


def fmt_da(centimes):
    v = Decimal(centimes) / 100
    s = f"{v:,.2f}".replace(",", " ").replace(".", ",")
    return (s[:-3] if s.endswith(",00") else s) + " DA"


def fmt_qty(milli, unit=""):
    v = Decimal(milli) / 1000
    s = f"{v:,.3f}".rstrip("0").rstrip(".").replace(",", " ").replace(".", ",")
    return s + (" " + unit if unit else "")


# ---------------------------------------------------------------- comptes
def hashpass(pw, salt):
    return hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), 310000).hex()


def check_password_strength(pw):
    if len(pw) < 10: raise Err("Mot de passe : 10 caractères minimum")
    if pw.isdigit() or pw.isalpha() or len(set(pw)) < 5: raise Err("Mot de passe trop simple : mélangez lettres et chiffres")


def create_user(c, username, display, role, pw, must_change=False):
    if not re.fullmatch(r"[a-zA-Z0-9._-]{3,40}", username or ""): raise Err("Identifiant : 3 à 40 lettres/chiffres sans espace")
    if role not in ("magasinier", "direction"): raise Err("Rôle invalide")
    check_password_strength(pw)
    if one(c, "SELECT id FROM users WHERE username=?", (username,)): raise Err("Cet identifiant existe déjà", 409)
    salt = secrets.token_hex(16)
    c.execute("INSERT INTO users(username,display_name,role,salt,password_hash,must_change,created_at) VALUES(?,?,?,?,?,?,?)",
              (username, display or username, role, salt, hashpass(pw, salt), 1 if must_change else 0, now()))
    return val(c, "SELECT last_insert_rowid()")


def authenticate(c, username, pw):
    u = one(c, "SELECT * FROM users WHERE username=?", (username,))
    fake = "00" * 16
    h = hashpass(pw, u["salt"] if u else fake)
    if not u or not hmac.compare_digest(h, u["password_hash"]) or not u["active"]: return None
    return u


def new_session(c, user_id, ip):
    token = secrets.token_urlsafe(32)
    hours = int(D.setting(c, "session_hours") or 12)
    exp = (datetime.now() + timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M:%S")
    c.execute("DELETE FROM sessions WHERE expires_at<?", (now(),))
    c.execute("INSERT INTO sessions(token_hash,user_id,created_at,expires_at,last_seen,ip) VALUES(?,?,?,?,?,?)",
              (hashlib.sha256(token.encode()).hexdigest(), user_id, now(), exp, now(), ip))
    return token


def session_user(c, token):
    if not token: return None
    th = hashlib.sha256(token.encode()).hexdigest()
    s = one(c, "SELECT s.*,u.id uid,u.username,u.display_name,u.role,u.active,u.must_change FROM sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=?", (th,))
    if not s or s["expires_at"] < now() or not s["active"]: return None
    return {"id": s["uid"], "username": s["username"], "display_name": s["display_name"], "role": s["role"], "must_change": s["must_change"], "token_hash": th}


def change_password(c, u, d):
    me = one(c, "SELECT * FROM users WHERE id=?", (u["id"],))
    if not hmac.compare_digest(hashpass(str(d.get("old", "")), me["salt"]), me["password_hash"]): raise Err("Ancien mot de passe incorrect", 403)
    pw = str(d.get("new", "")); check_password_strength(pw)
    salt = secrets.token_hex(16)
    c.execute("UPDATE users SET salt=?,password_hash=?,must_change=0 WHERE id=?", (salt, hashpass(pw, salt), u["id"]))
    c.execute("DELETE FROM sessions WHERE user_id=? AND token_hash<>?", (u["id"], u["token_hash"]))
    audit(c, u["id"], "mot_de_passe_change", "user", u["id"])
    return {"ok": True}


UNLOCK_HOOK = None  # fourni par server.py : débloque le compte après un nouveau mot de passe

def admin_user(c, u, d):
    need(u, "direction")
    action = d.get("action")
    if action == "creer":
        i = create_user(c, text(d, "username", 40, label="Identifiant"), text(d, "display_name", 60, label="Nom"),
                        d.get("role"), str(d.get("password", "")), must_change=True)
        audit(c, u["id"], "compte_cree", "user", i, {"username": d.get("username"), "role": d.get("role")})
        return {"id": i}
    uid_ = intid(d, "user_id")
    target = one(c, "SELECT * FROM users WHERE id=?", (uid_,))
    if not target: raise Err("Compte inconnu", 404)
    if action == "mot_de_passe":
        pw = str(d.get("password", "")); check_password_strength(pw); salt = secrets.token_hex(16)
        c.execute("UPDATE users SET salt=?,password_hash=?,must_change=1 WHERE id=?", (salt, hashpass(pw, salt), uid_))
        c.execute("DELETE FROM sessions WHERE user_id=?", (uid_,))
        if UNLOCK_HOOK: UNLOCK_HOOK(target["username"])
    elif action in ("desactiver", "activer"):
        if uid_ == u["id"]: raise Err("Vous ne pouvez pas désactiver votre propre compte")
        if action == "desactiver" and target["role"] == "direction" and val(c, "SELECT COUNT(*) FROM users WHERE role='direction' AND active=1") <= 1:
            raise Err("Il doit rester au moins un compte direction actif")
        c.execute("UPDATE users SET active=? WHERE id=?", (1 if action == "activer" else 0, uid_))
        c.execute("DELETE FROM sessions WHERE user_id=?", (uid_,))
    else: raise Err("Action inconnue")
    audit(c, u["id"], "compte_" + action, "user", uid_)
    return {"ok": True}


# ---------------------------------------------------------------- référentiel
def save_supplier(c, u, d):
    name = text(d, "name", 100, label="Nom du fournisseur")
    vals = (name, text(d, "contact", 100, False), text(d, "phone", 40, False), text(d, "notes", 500, False), 0 if d.get("active") is False else 1)
    sid = intid(d, "id", required=False)
    try:
        if sid:
            if not one(c, "SELECT id FROM suppliers WHERE id=?", (sid,)): raise Err("Fournisseur inconnu", 404)
            c.execute("UPDATE suppliers SET name=?,contact=?,phone=?,notes=?,active=? WHERE id=?", vals + (sid,))
        else:
            c.execute("INSERT INTO suppliers(name,contact,phone,notes,active,created_at) VALUES(?,?,?,?,?,?)", vals + (now(),))
            sid = val(c, "SELECT last_insert_rowid()")
    except D.sqlite3.IntegrityError: raise Err("Un fournisseur porte déjà ce nom", 409)
    audit(c, u["id"], "fournisseur_enregistre", "supplier", sid, {"name": name})
    return {"id": sid}


def save_item(c, u, d):
    name = text(d, "name", 100, label="Nom de l'article")
    iid = intid(d, "id", required=False)
    base = d.get("base_unit")
    if base not in D.BASE_UNITS: raise Err("Unité de base : kg, L ou u")
    min_qty = int(qty_milli(d.get("min_qty") or 0, "Seuil d'alerte", allow_zero=True) * 1000)
    vals = (name, text(d, "category", 60, False), min_qty, text(d, "location", 60, False), 0 if d.get("active") is False else 1)
    units = d.get("units") or []
    if not isinstance(units, list) or len(units) > 20: raise Err("Conditionnements invalides")
    clean = []
    for x in units:
        n = text(x, "name", 30, label="Nom du conditionnement")
        if n in STD_UNITS[base] or any(n.lower() == k.lower() for k in sum((list(v) for v in STD_UNITS.values()), [])):
            raise Err(f"« {n} » est une unité standard : inutile de la déclarer")
        clean.append((n, float(qty_milli(x.get("factor"), f"Contenu de « {n} »"))))
    if len({n.lower() for n, _ in clean}) != len(clean): raise Err("Conditionnement en double")
    try:
        if iid:
            cur = one(c, "SELECT * FROM items WHERE id=?", (iid,))
            if not cur: raise Err("Article inconnu", 404)
            if cur["base_unit"] != base and val(c, "SELECT COUNT(*) FROM stock_movements WHERE item_id=?", (iid,)):
                raise Err("Unité de base non modifiable : l'article a déjà des mouvements")
            c.execute("UPDATE items SET name=?,category=?,min_qty=?,location=?,active=?,base_unit=? WHERE id=?", vals + (base, iid))
            used = {r["unit_name"].lower() for r in rows(c, "SELECT DISTINCT unit_name FROM receipt_lines WHERE item_id=?", (iid,))}
            old = {r["name"].lower(): r["factor"] for r in rows(c, "SELECT name,factor FROM item_units WHERE item_id=?", (iid,))}
            for n, f in old.items():
                if n in used and not any(n == k.lower() and abs(f - v) < 1e-9 for k, v in clean):
                    raise Err(f"Le conditionnement « {n} » a déjà servi : il ne peut être ni supprimé ni modifié")
            c.execute("DELETE FROM item_units WHERE item_id=?", (iid,))
        else:
            c.execute("INSERT INTO items(name,category,min_qty,location,active,base_unit,created_at) VALUES(?,?,?,?,?,?,?)", vals + (base, now()))
            iid = val(c, "SELECT last_insert_rowid()")
        for n, f in clean:
            c.execute("INSERT INTO item_units(item_id,name,factor) VALUES(?,?,?)", (iid, n, f))
    except D.sqlite3.IntegrityError: raise Err("Un article porte déjà ce nom", 409)
    audit(c, u["id"], "article_enregistre", "item", iid, {"name": name, "base_unit": base, "units": clean})
    return {"id": iid}


def import_catalogue(c, path):
    """Catalogue de départ (articles sans quantité), importé une seule fois. Les articles déjà présents ne sont pas touchés."""
    import json
    from pathlib import Path
    key = "catalogue_initial_v1"
    if val(c, "SELECT value FROM settings WHERE key=?", (key,)) or not Path(path).exists(): return 0
    n = 0
    for x in json.loads(Path(path).read_text(encoding="utf-8")):
        name = str(x.get("name", "")).strip()[:100]; base = x.get("base_unit")
        if not name or base not in D.BASE_UNITS or one(c, "SELECT id FROM items WHERE name=?", (name,)): continue
        c.execute("INSERT INTO items(name,category,min_qty,location,active,base_unit,created_at) VALUES(?,?,0,'',1,?,?)",
                  (name, str(x.get("category", ""))[:60], base, now()))
        n += 1
    c.execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", (key, now()))
    audit(c, None, "catalogue_importe", "item", None, {"articles": n})
    return n


def unit_factor(c, item, unit):
    unit = (unit or item["base_unit"]).strip()
    std = STD_UNITS[item["base_unit"]]
    for k, f in std.items():
        if k.lower() == unit.lower(): return k, Decimal(str(f))
    r = one(c, "SELECT name,factor FROM item_units WHERE item_id=? AND name=?", (item["id"], unit))
    if r: return r["name"], Decimal(str(r["factor"]))
    raise Err(f"Unité « {unit} » non prévue pour {item['name']}")


def get_item(c, iid, active_only=True):
    it = one(c, "SELECT * FROM items WHERE id=?", (iid,))
    if not it: raise Err("Article inconnu", 404)
    if active_only and not it["active"]: raise Err(f"Article désactivé : {it['name']}")
    return it


def to_base(c, item, q, unit):
    name, f = unit_factor(c, item, unit)
    dq = qty_milli(q)
    milli = (dq * f * 1000).to_integral_value(ROUND_HALF_UP)
    if milli <= 0: raise Err(f"Quantité trop petite pour {item['name']}")
    return name, f, dq, int(milli)


# ---------------------------------------------------------------- mouvements (CUMP)
def move(c, u, item_id, kind, qty, value=None, service=None, ref_type="", ref_id=0, allow_clamp=False):
    """qty signé en millièmes. value signé en centimes ; None = valorisé au coût moyen pondéré."""
    it = one(c, "SELECT * FROM items WHERE id=?", (item_id,))
    q0, v0 = it["qty"], it["value"]
    avg = (v0 / q0) if q0 > 0 else (it["last_cost"] / 1000.0)
    if qty < 0:
        if q0 + qty < 0:
            if not allow_clamp:
                raise Err(f"Stock insuffisant pour {it['name']} : disponible {fmt_qty(q0, it['base_unit'])}, demandé {fmt_qty(-qty, it['base_unit'])}", 409, "stock_insuffisant")
            qty = -q0
            if qty == 0: return 0
        if value is None:
            value = -v0 if q0 + qty == 0 else -int(round(v0 * (-qty) / q0))
        else:
            value = -min(-value, v0)
            if q0 + qty == 0: value = -v0
    else:
        if value is None: value = int(round(avg * qty))
    q1, v1 = q0 + qty, v0 + value
    if q1 == 0: v1 = 0
    unit_cost = abs(value) / abs(qty) * 1000 if qty else 0  # centimes par unité de base
    upd_last = ", last_cost=?" if kind == "reception" else ""
    args = [q1, v1] + ([unit_cost] if kind == "reception" else []) + [item_id]
    c.execute(f"UPDATE items SET qty=?, value=?{upd_last} WHERE id=?", args)
    c.execute("INSERT INTO stock_movements(item_id,kind,qty,value,unit_cost,service,ref_type,ref_id,qty_after,value_after,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
              (item_id, kind, qty, value, unit_cost, service, ref_type, ref_id, q1, v1, u["id"], now()))
    return value


# ---------------------------------------------------------------- réceptions
def receipt_lines_input(c, lines):
    if not isinstance(lines, list) or not lines: raise Err("Ajoutez au moins un article")
    if len(lines) > 200: raise Err("200 lignes maximum par bon")
    out = []
    for i, x in enumerate(lines, 1):
        if not isinstance(x, dict): raise Err(f"Ligne {i} invalide")
        it = get_item(c, intid(x, "item_id", f"Article ligne {i}"))
        uname, f, dq, milli = to_base(c, it, x.get("qty"), x.get("unit"))
        price = money(x.get("unit_price"), f"Prix ligne {i}", allow_zero=True)
        disc = dec(x.get("discount_pct") or 0, f"Remise ligne {i}", 2)
        if disc < 0 or disc >= 100: raise Err(f"Remise ligne {i} invalide")
        total = int((dq * price * (1 - disc / 100)).to_integral_value(ROUND_HALF_UP))
        out.append(dict(item=it, unit=uname, factor=f, dq=dq, milli=milli, price=price, disc=disc, total=total))
    return out


def duplicate_check(c, table, supplier, key, total, doc_date, d, label):
    if one(c, f"SELECT id FROM {table} WHERE supplier_id=? AND number_key=? AND status IN ('validee','active')", (supplier, key)):
        raise Err(f"Doublon : ce {label} existe déjà pour ce fournisseur", 409, "doublon")
    col = "total" if table == "receipts" else "amount"
    near = rows(c, f"SELECT id,number,doc_date FROM {table} WHERE supplier_id=? AND {col}=? AND status IN ('validee','active') AND ABS(julianday(doc_date)-julianday(?))<=3", (supplier, total, doc_date))
    if near:
        reason = text(d, "duplicate_reason", 300, False)
        if not (d.get("force") and reason):
            raise Err(f"Doublon probable : même fournisseur, même montant ({fmt_da(total)}) à moins de 3 jours — n° " + ", ".join(n["number"] for n in near) +
                      ". Confirmez en indiquant la raison.", 409, "doublon_probable", {"similaires": near})
        return reason
    return None


def create_receipt(c, u, d):
    need(u, "magasinier")
    ex = existing(c, "receipts", uid(d))
    if ex: return ex
    sup = intid(d, "supplier_id", "Fournisseur")
    s = one(c, "SELECT * FROM suppliers WHERE id=?", (sup,))
    if not s or not s["active"]: raise Err("Fournisseur inconnu ou désactivé")
    number = text(d, "number", 60, label="N° du bon"); key = number_key(number)
    if not key: raise Err("N° du bon invalide")
    doc_date = day(d, "doc_date", "Date du bon")
    if doc_date > date.today().isoformat(): raise Err("La date du bon ne peut pas être dans le futur")
    lines = receipt_lines_input(c, d.get("lines"))
    total = sum(x["total"] for x in lines)
    dup = duplicate_check(c, "receipts", sup, key, total, doc_date, d, "bon")
    inv = d.get("invoice") if isinstance(d.get("invoice"), dict) else None
    c.execute("INSERT INTO receipts(supplier_id,number,number_key,doc_date,status,total,notes,duplicate_reason,created_by,created_at,client_uid) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
              (sup, number, key, doc_date, "validee", total, text(d, "notes", 500, False), dup, u["id"], now(), uid(d)))
    rid = val(c, "SELECT last_insert_rowid()")
    for x in lines:
        c.execute("INSERT INTO receipt_lines(receipt_id,item_id,qty_entered,unit_name,factor,qty,unit_price,discount_pct,total) VALUES(?,?,?,?,?,?,?,?,?)",
                  (rid, x["item"]["id"], float(x["dq"]), x["unit"], float(x["factor"]), x["milli"], x["price"], float(x["disc"]), x["total"]))
        move(c, u, x["item"]["id"], "reception", x["milli"], x["total"], None, "reception", rid)
    audit(c, u["id"], "reception_validee", "receipt", rid, {"supplier": s["name"], "number": number, "total": total, "lignes": len(lines), "doublon_force": dup})
    out = {"id": rid, "total": total}
    if inv:  # le bon vaut facture
        amount = money(inv.get("amount"), "Montant de la facture") if inv.get("amount") not in (None, "") else total
        out["invoice_id"] = create_invoice(c, u, {"supplier_id": sup, "number": inv.get("number") or number, "doc_date": doc_date,
                                                  "due_date": inv.get("due_date"), "amount": Decimal(amount) / 100, "receipt_ids": [rid],
                                                  "force": d.get("force"), "duplicate_reason": d.get("duplicate_reason")})["id"]
    return out


def cancel_receipt(c, u, d):
    need(u, "direction")
    rid = intid(d, "receipt_id"); reason = text(d, "reason", 300, label="Motif")
    r = one(c, "SELECT * FROM receipts WHERE id=?", (rid,))
    if not r or r["status"] != "validee": raise Err("Bon introuvable ou déjà annulé", 409)
    if one(c, "SELECT 1 FROM invoice_receipts ir JOIN invoices i ON i.id=ir.invoice_id WHERE receipt_id=? AND i.status='active'", (rid,)):
        raise Err("Ce bon est rapproché d'une facture active : annulez ou corrigez d'abord la facture", 409)
    for l in rows(c, "SELECT * FROM receipt_lines WHERE receipt_id=?", (rid,)):
        move(c, u, l["item_id"], "annulation_reception", -l["qty"], -l["total"], None, "reception", rid)
    c.execute("DELETE FROM invoice_receipts WHERE receipt_id=?", (rid,))
    c.execute("UPDATE receipts SET status='annulee',cancelled_by=?,cancelled_at=?,cancel_reason=? WHERE id=?", (u["id"], now(), reason, rid))
    audit(c, u["id"], "reception_annulee", "receipt", rid, {"reason": reason})
    return {"ok": True}


# ---------------------------------------------------------------- sorties, retours, pertes
def create_issue(c, u, d):
    need(u, "magasinier")
    ex = existing(c, "issue_slips", uid(d))
    if ex: return ex
    kind = d.get("kind") or "sortie"
    if kind not in ISSUE_KINDS: raise Err("Type de mouvement inconnu")
    service = d.get("service") or None
    supplier = None
    if kind in ("sortie", "retour_service"):
        if service not in SERVICES: raise Err("Choisissez le service")
    else: service = None
    reason = text(d, "reason", 300, kind in ("perte", "retour_fournisseur"), "Motif")
    if kind == "retour_fournisseur":
        supplier = intid(d, "supplier_id", "Fournisseur")
        if not one(c, "SELECT id FROM suppliers WHERE id=?", (supplier,)): raise Err("Fournisseur inconnu")
    lines = d.get("lines")
    if not isinstance(lines, list) or not lines: raise Err("Ajoutez au moins un article")
    if len(lines) > 200: raise Err("200 lignes maximum")
    parsed, seen = [], {}
    for i, x in enumerate(lines, 1):
        it = get_item(c, intid(x, "item_id", f"Article ligne {i}"), active_only=False)
        _, _, _, milli = to_base(c, it, x.get("qty"), x.get("unit"))
        seen[it["id"]] = seen.get(it["id"], 0) + milli
        parsed.append((it, milli))
    if kind != "retour_service":
        short = []
        for iid, q in seen.items():
            it = one(c, "SELECT name,qty,base_unit FROM items WHERE id=?", (iid,))
            if it["qty"] < q: short.append(f"{it['name']} (disponible {fmt_qty(it['qty'], it['base_unit'])}, demandé {fmt_qty(q, it['base_unit'])})")
        if short: raise Err("Stock insuffisant : " + " ; ".join(short), 409, "stock_insuffisant")
    c.execute("INSERT INTO issue_slips(kind,service,supplier_id,requested_by,reason,created_by,created_at,client_uid) VALUES(?,?,?,?,?,?,?,?)",
              (kind, service, supplier, text(d, "requested_by", 60, False), reason, u["id"], now(), uid(d)))
    sid = val(c, "SELECT last_insert_rowid()")
    total = 0
    for it, milli in parsed:
        total += abs(move(c, u, it["id"], kind, milli if kind == "retour_service" else -milli, None, service, "issue", sid))
    c.execute("UPDATE issue_slips SET total=? WHERE id=?", (total, sid))
    audit(c, u["id"], kind, "issue", sid, {"service": service, "lignes": len(parsed), "valeur": total})
    return {"id": sid, "total": total}


# ---------------------------------------------------------------- factures
def due(c, invoice_id):
    inv = one(c, "SELECT amount,status FROM invoices WHERE id=?", (invoice_id,))
    if not inv: raise Err("Facture inconnue", 404)
    if inv["status"] != "active": return 0
    cr = val(c, "SELECT COALESCE(SUM(amount),0) FROM credit_notes WHERE invoice_id=?", (invoice_id,))
    return inv["amount"] - cr - paid(c, invoice_id)


def paid(c, invoice_id, request_id=None):
    sql = "SELECT COALESCE(SUM(p.amount),0) FROM payments p LEFT JOIN payment_cancellations x ON x.payment_id=p.id WHERE x.payment_id IS NULL AND p.invoice_id=?"
    args = [invoice_id]
    if request_id: sql += " AND p.request_id=?"; args.append(request_id)
    return val(c, sql, args)


def link_receipts(c, inv_id, supplier, ids):
    for r in ids:
        rec = one(c, "SELECT * FROM receipts WHERE id=?", (r,))
        if not rec or rec["status"] != "validee" or rec["supplier_id"] != supplier: raise Err(f"Bon {r} : introuvable, annulé ou d'un autre fournisseur")
        other = one(c, "SELECT i.number FROM invoice_receipts ir JOIN invoices i ON i.id=ir.invoice_id WHERE ir.receipt_id=? AND ir.invoice_id<>? AND i.status='active'", (r, inv_id))
        if other: raise Err(f"Le bon {rec['number']} est déjà rapproché de la facture {other['number']}", 409)
        c.execute("DELETE FROM invoice_receipts WHERE receipt_id=?", (r,))
        c.execute("INSERT INTO invoice_receipts(invoice_id,receipt_id) VALUES(?,?)", (inv_id, r))


def create_invoice(c, u, d):
    ex = existing(c, "invoices", uid(d))
    if ex: return ex
    kind = d.get("kind") or "facture"
    if kind not in ("facture", "solde_initial"): raise Err("Type de pièce inconnu")
    sup = intid(d, "supplier_id", "Fournisseur")
    if not one(c, "SELECT id FROM suppliers WHERE id=?", (sup,)): raise Err("Fournisseur inconnu")
    number = text(d, "number", 60, label="N° de facture") if kind == "facture" else (text(d, "number", 60, False) or "SOLDE-INITIAL")
    key = number_key(number) if kind == "facture" else "SOLDEINITIAL" + number_key(number)
    doc_date = day(d, "doc_date", "Date de facture")
    if doc_date > date.today().isoformat(): raise Err("La date de facture ne peut pas être dans le futur")
    due_date = day(d, "due_date", "Échéance", required=False)
    amount = money(d.get("amount"), "Montant TTC")
    dup = duplicate_check(c, "invoices", sup, key, amount, doc_date, d, "numéro de facture")
    c.execute("INSERT INTO invoices(supplier_id,kind,number,number_key,doc_date,due_date,amount,notes,status,duplicate_reason,created_by,created_at,client_uid) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
              (sup, kind, number, key, doc_date, due_date, amount, text(d, "notes", 500, False), "active", dup, u["id"], now(), uid(d)))
    iid = val(c, "SELECT last_insert_rowid()")
    ids = d.get("receipt_ids") or []
    if not isinstance(ids, list): raise Err("Bons rapprochés invalides")
    link_receipts(c, iid, sup, [intid({"x": r}, "x") for r in ids])
    audit(c, u["id"], "facture_enregistree", "invoice", iid, {"number": number, "amount": amount, "kind": kind, "bons": ids, "doublon_force": dup})
    return {"id": iid, "ecart": reconcile(c, iid)["ecart"]}


def reconcile(c, iid):
    inv = one(c, "SELECT * FROM invoices WHERE id=?", (iid,))
    rec = rows(c, "SELECT r.id,r.number,r.doc_date,r.total FROM invoice_receipts ir JOIN receipts r ON r.id=ir.receipt_id WHERE ir.invoice_id=? ORDER BY r.doc_date", (iid,))
    t = sum(r["total"] for r in rec)
    return {"bons": rec, "total_bons": t, "ecart": (inv["amount"] - t) if rec else None}


def invoice_link(c, u, d):
    iid = intid(d, "invoice_id")
    inv = one(c, "SELECT * FROM invoices WHERE id=?", (iid,))
    if not inv or inv["status"] != "active": raise Err("Facture introuvable", 404)
    ids = [intid({"x": r}, "x") for r in (d.get("receipt_ids") or [])]
    c.execute("DELETE FROM invoice_receipts WHERE invoice_id=?", (iid,))
    link_receipts(c, iid, inv["supplier_id"], ids)
    audit(c, u["id"], "rapprochement", "invoice", iid, {"bons": ids})
    return reconcile(c, iid)


def cancel_invoice(c, u, d):
    need(u, "direction")
    iid = intid(d, "invoice_id"); reason = text(d, "reason", 300, label="Motif")
    inv = one(c, "SELECT * FROM invoices WHERE id=?", (iid,))
    if not inv or inv["status"] != "active": raise Err("Facture introuvable ou déjà annulée", 409)
    if paid(c, iid): raise Err("Des paiements sont enregistrés sur cette facture : annulez-les d'abord", 409)
    if one(c, f"SELECT 1 FROM payment_request_lines l JOIN payment_requests r ON r.id=l.request_id WHERE l.invoice_id=? AND r.status IN {OPEN_REQUEST}", (iid,)):
        raise Err("Facture présente dans une demande de paiement en cours", 409)
    c.execute("UPDATE invoices SET status='annulee',cancelled_by=?,cancelled_at=?,cancel_reason=? WHERE id=?", (u["id"], now(), reason, iid))
    c.execute("DELETE FROM invoice_receipts WHERE invoice_id=?", (iid,))
    audit(c, u["id"], "facture_annulee", "invoice", iid, {"reason": reason})
    return {"ok": True}


def create_credit(c, u, d):
    ex = existing(c, "credit_notes", uid(d))
    if ex: return ex
    iid = intid(d, "invoice_id", "Facture")
    amount = money(d.get("amount"), "Montant de l'avoir")
    if amount > due(c, iid): raise Err(f"L'avoir dépasse le reste dû ({fmt_da(due(c, iid))})", 409)
    c.execute("INSERT INTO credit_notes(invoice_id,number,amount,doc_date,reason,created_by,created_at,client_uid) VALUES(?,?,?,?,?,?,?,?)",
              (iid, text(d, "number", 60, label="N° d'avoir"), amount, day(d, "doc_date", "Date"), text(d, "reason", 300, label="Motif"), u["id"], now(), uid(d)))
    cid = val(c, "SELECT last_insert_rowid()")
    audit(c, u["id"], "avoir_enregistre", "credit", cid, {"invoice": iid, "amount": amount})
    refresh_requests_for_invoice(c, iid)
    return {"id": cid}


# ---------------------------------------------------------------- demandes de paiement
def week_bounds(c, any_day):
    ws = int(D.setting(c, "week_start"))  # 0=dimanche
    d0 = date.fromisoformat(any_day)
    back = (d0.isoweekday() % 7 - ws) % 7
    start = d0 - timedelta(days=back)
    return start.isoformat(), (start + timedelta(days=6)).isoformat()


def locked_invoices(c, exclude_request=None):
    return {r["invoice_id"]: r["number"] for r in rows(c, f"SELECT l.invoice_id,r.number FROM payment_request_lines l JOIN payment_requests r ON r.id=l.request_id WHERE r.status IN {OPEN_REQUEST} AND r.id<>?", (exclude_request or 0,))}


def invoices_payable(c, exclude_request=None):
    locked = locked_invoices(c, exclude_request)
    out = []
    for inv in rows(c, "SELECT i.*,s.name supplier FROM invoices i JOIN suppliers s ON s.id=i.supplier_id WHERE i.status='active' ORDER BY s.name,i.doc_date"):
        dv = due(c, inv["id"])
        if dv > 0:
            inv["due"] = dv; inv["locked_by"] = locked.get(inv["id"]); out.append(inv)
    return out


def request_lines_input(c, d, rid=None, week_start=None):
    lines = d.get("lines")
    if not isinstance(lines, list) or not lines: raise Err("Sélectionnez au moins une facture")
    locked = locked_invoices(c, rid)
    out, seen = [], set()
    for x in lines:
        iid = intid(x, "invoice_id", "Facture")
        if iid in seen: raise Err("Facture en double dans la demande")
        seen.add(iid)
        inv = one(c, "SELECT i.*,s.name supplier FROM invoices i JOIN suppliers s ON s.id=i.supplier_id WHERE i.id=?", (iid,))
        if not inv or inv["status"] != "active": raise Err("Facture introuvable ou annulée")
        if iid in locked: raise Err(f"La facture {inv['number']} ({inv['supplier']}) est déjà dans la demande {locked[iid]}", 409, "deja_demandee")
        dv = due(c, iid)
        if dv <= 0: raise Err(f"La facture {inv['number']} est déjà réglée", 409)
        amt = dv if x.get("amount") in (None, "") else money(x.get("amount"), f"Montant facture {inv['number']}")
        if amt > dv: raise Err(f"Facture {inv['number']} : montant demandé supérieur au reste dû ({fmt_da(dv)})", 409)
        out.append((iid, dv, amt, 1 if week_start and inv["doc_date"] < week_start else 0))
    return out


def next_request_number(c, year):
    n = val(c, "SELECT COUNT(*) FROM payment_requests WHERE number LIKE ?", (f"DP-{year}-%",)) + 1
    return f"DP-{year}-{n:03d}"


def snapshot(c, rid):
    r = one(c, "SELECT * FROM payment_requests WHERE id=?", (rid,))
    r["lines"] = rows(c, "SELECT * FROM payment_request_lines WHERE request_id=? ORDER BY id", (rid,))
    return json.dumps(r, ensure_ascii=False)


def save_request(c, u, d):
    need(u, "magasinier")
    rid = intid(d, "id", required=False)
    if rid:
        r = one(c, "SELECT * FROM payment_requests WHERE id=?", (rid,))
        if not r: raise Err("Demande inconnue", 404)
        if r["status"] not in ("brouillon", "a_corriger"): raise Err("Demande verrouillée : elle n'est plus modifiable", 409)
        lines = request_lines_input(c, d, rid, r["week_start"])
        c.execute("DELETE FROM payment_request_lines WHERE request_id=?", (rid,))
        c.execute("UPDATE payment_requests SET note=? WHERE id=?", (text(d, "note", 1000, False), rid))
    else:
        ex = existing(c, "payment_requests", uid(d))
        if ex: return ex
        ws, we = week_bounds(c, day(d, "week_of", "Semaine", default=date.today().isoformat()))
        lines = request_lines_input(c, d, None, ws)
        c.execute("INSERT INTO payment_requests(number,week_start,week_end,status,note,created_by,created_at,client_uid) VALUES(?,?,?,?,?,?,?,?)",
                  (next_request_number(c, ws[:4]), ws, we, "brouillon", text(d, "note", 1000, False), u["id"], now(), uid(d)))
        rid = val(c, "SELECT last_insert_rowid()")
    for iid, dv, amt, old in lines:
        c.execute("INSERT INTO payment_request_lines(request_id,invoice_id,due_at_submit,requested,is_old) VALUES(?,?,?,?,?)", (rid, iid, dv, amt, old))
    audit(c, u["id"], "demande_enregistree", "request", rid, {"lignes": len(lines), "total": sum(x[2] for x in lines)})
    if d.get("submit"): return submit_request(c, u, {"request_id": rid})
    return {"id": rid}


def submit_request(c, u, d):
    need(u, "magasinier")
    rid = intid(d, "request_id")
    r = one(c, "SELECT * FROM payment_requests WHERE id=?", (rid,))
    if not r or r["status"] not in ("brouillon", "a_corriger"): raise Err("Seule une demande en brouillon ou à corriger peut être soumise", 409)
    for l in rows(c, "SELECT * FROM payment_request_lines WHERE request_id=?", (rid,)):
        dv = due(c, l["invoice_id"])
        if l["requested"] > dv: raise Err("Une facture a été réglée ou modifiée entre-temps : ouvrez la demande et corrigez-la", 409)
        c.execute("UPDATE payment_request_lines SET due_at_submit=?,approved=NULL WHERE id=?", (dv, l["id"]))
    c.execute("UPDATE payment_requests SET status='soumise',revision=revision+1,submitted_at=?,reviewed_by=NULL,reviewed_at=NULL WHERE id=?", (now(), rid))
    rev = val(c, "SELECT revision FROM payment_requests WHERE id=?", (rid,))
    c.execute("INSERT INTO payment_request_revisions(request_id,revision,event,snapshot,user_id,at) VALUES(?,?,?,?,?,?)", (rid, rev, "soumise", snapshot(c, rid), u["id"], now()))
    audit(c, u["id"], "demande_soumise", "request", rid, {"revision": rev})
    return {"id": rid, "revision": rev}


def delete_draft(c, u, d):
    need(u, "magasinier")
    rid = intid(d, "request_id")
    r = one(c, "SELECT * FROM payment_requests WHERE id=?", (rid,))
    if not r or r["status"] != "brouillon" or r["revision"] > 0: raise Err("Seul un brouillon jamais soumis peut être supprimé", 409)
    c.execute("DELETE FROM payment_request_lines WHERE request_id=?", (rid,))
    c.execute("UPDATE payment_requests SET status='cloturee',closed_at=?,review_comment='Brouillon abandonné' WHERE id=?", (now(), rid))
    audit(c, u["id"], "brouillon_abandonne", "request", rid)
    return {"ok": True}


def review_request(c, u, d):
    need(u, "direction")
    rid = intid(d, "request_id"); action = d.get("action")
    r = one(c, "SELECT * FROM payment_requests WHERE id=?", (rid,))
    if not r or r["status"] != "soumise": raise Err("Cette demande n'est pas en attente de validation", 409)
    if action not in ("approuver", "refuser", "corriger"): raise Err("Action inconnue")
    comment = text(d, "comment", 1000, action != "approuver", "Commentaire")
    status = {"approuver": "approuvee", "refuser": "refusee", "corriger": "a_corriger"}[action]
    if action == "approuver":
        caps = {int(k): v for k, v in (d.get("approved") or {}).items()} if isinstance(d.get("approved"), dict) else {}
        for l in rows(c, "SELECT * FROM payment_request_lines WHERE request_id=?", (rid,)):
            a = l["requested"] if l["id"] not in caps else money(caps[l["id"]], "Montant approuvé", allow_zero=True)
            if a > l["requested"]: raise Err("Le montant approuvé ne peut pas dépasser le montant demandé")
            c.execute("UPDATE payment_request_lines SET approved=? WHERE id=?", (a, l["id"]))
        if not val(c, "SELECT COALESCE(SUM(approved),0) FROM payment_request_lines WHERE request_id=?", (rid,)):
            raise Err("Montant approuvé nul : refusez plutôt la demande")
    c.execute("UPDATE payment_requests SET status=?,reviewed_by=?,reviewed_at=?,review_comment=? WHERE id=?", (status, u["id"], now(), comment, rid))
    c.execute("INSERT INTO payment_request_revisions(request_id,revision,event,snapshot,user_id,at) VALUES(?,?,?,?,?,?)", (rid, r["revision"], status, snapshot(c, rid), u["id"], now()))
    audit(c, u["id"], "demande_" + status, "request", rid, {"comment": comment})
    return {"ok": True, "statut": status}


def request_status_refresh(c, rid):
    r = one(c, "SELECT * FROM payment_requests WHERE id=?", (rid,))
    if r["status"] not in ("approuvee", "partiellement_payee", "payee"): return
    total_app = paid_sum = 0; complete = True
    for l in rows(c, "SELECT * FROM payment_request_lines WHERE request_id=?", (rid,)):
        p = paid(c, l["invoice_id"], rid)
        total_app += l["approved"] or 0; paid_sum += p
        if p < (l["approved"] or 0) and due(c, l["invoice_id"]) > 0: complete = False
    st = "payee" if complete and paid_sum > 0 else ("partiellement_payee" if paid_sum > 0 else ("payee" if complete else "approuvee"))
    if st != r["status"]:
        c.execute("UPDATE payment_requests SET status=?,closed_at=? WHERE id=?", (st, now() if st == "payee" else None, rid))


def refresh_requests_for_invoice(c, iid):
    for r in rows(c, "SELECT DISTINCT request_id FROM payment_request_lines WHERE invoice_id=?", (iid,)):
        request_status_refresh(c, r["request_id"])


def confirm_payment(c, u, d):
    need(u, "direction")
    ex = existing(c, "payments", uid(d))
    if ex: return ex
    rid = intid(d, "request_id", "Demande"); iid = intid(d, "invoice_id", "Facture")
    r = one(c, "SELECT * FROM payment_requests WHERE id=?", (rid,))
    if not r: raise Err("Demande inconnue", 404)
    if r["status"] not in ("approuvee", "partiellement_payee"):
        raise Err("Paiement impossible : la demande doit être approuvée (statut actuel : " + r["status"].replace("_", " ") + ")", 409, "non_approuvee")
    l = one(c, "SELECT * FROM payment_request_lines WHERE request_id=? AND invoice_id=?", (rid, iid))
    if not l: raise Err("Cette facture ne fait pas partie de la demande", 409)
    amount = money(d.get("amount"), "Montant payé")
    remaining = min((l["approved"] or 0) - paid(c, iid, rid), due(c, iid))
    if remaining <= 0: raise Err("Cette facture est déjà entièrement réglée pour cette demande : double paiement refusé", 409, "double_paiement")
    if amount > remaining: raise Err(f"Montant supérieur au reste à payer ({fmt_da(remaining)})", 409, "depassement")
    mode = d.get("mode")
    if mode not in PAY_MODES: raise Err("Mode de paiement : espèces, chèque, virement ou autre")
    paid_on = day(d, "paid_on", "Date du paiement", default=date.today().isoformat())
    if paid_on > date.today().isoformat(): raise Err("La date de paiement ne peut pas être dans le futur")
    ref = text(d, "reference", 80, mode in ("cheque", "virement"), "Référence (n° de chèque ou de virement)")
    c.execute("INSERT INTO payments(invoice_id,request_id,amount,paid_on,mode,reference,note,confirmed_by,confirmed_at,client_uid) VALUES(?,?,?,?,?,?,?,?,?,?)",
              (iid, rid, amount, paid_on, mode, ref, text(d, "note", 300, False), u["id"], now(), uid(d)))
    pid = val(c, "SELECT last_insert_rowid()")
    request_status_refresh(c, rid)
    audit(c, u["id"], "paiement_confirme", "payment", pid, {"request": r["number"], "invoice": iid, "amount": amount, "mode": mode, "reference": ref})
    return {"id": pid, "reste": remaining - amount}


def cancel_payment(c, u, d):
    need(u, "direction")
    pid = intid(d, "payment_id"); reason = text(d, "reason", 300, label="Motif")
    p = one(c, "SELECT * FROM payments WHERE id=?", (pid,))
    if not p: raise Err("Paiement inconnu", 404)
    if one(c, "SELECT 1 FROM payment_cancellations WHERE payment_id=?", (pid,)): raise Err("Paiement déjà annulé", 409)
    c.execute("INSERT INTO payment_cancellations(payment_id,reason,user_id,at) VALUES(?,?,?,?)", (pid, reason, u["id"], now()))
    st = val(c, "SELECT status FROM payment_requests WHERE id=?", (p["request_id"],))
    if st == "payee":
        c.execute("UPDATE payment_requests SET status='partiellement_payee',closed_at=NULL WHERE id=?", (p["request_id"],))
    request_status_refresh(c, p["request_id"])
    audit(c, u["id"], "paiement_annule", "payment", pid, {"reason": reason, "amount": p["amount"]})
    return {"ok": True}


def close_request(c, u, d):
    need(u, "direction")
    rid = intid(d, "request_id")
    r = one(c, "SELECT * FROM payment_requests WHERE id=?", (rid,))
    if not r or r["status"] not in ("approuvee", "partiellement_payee"): raise Err("Seule une demande approuvée ou partiellement payée peut être clôturée", 409)
    c.execute("UPDATE payment_requests SET status='cloturee',closed_at=?,review_comment=COALESCE(review_comment,'')||? WHERE id=?",
              (now(), " | Clôturée : " + text(d, "comment", 300, False), rid))
    audit(c, u["id"], "demande_cloturee", "request", rid)
    return {"ok": True}


def request_detail(c, rid):
    r = one(c, "SELECT r.*,u.display_name author,v.display_name reviewer FROM payment_requests r JOIN users u ON u.id=r.created_by LEFT JOIN users v ON v.id=r.reviewed_by WHERE r.id=?", (rid,))
    if not r: raise Err("Demande inconnue", 404)
    r["lines"] = rows(c, """SELECT l.*,i.number,i.doc_date,i.due_date,i.amount invoice_amount,i.kind,s.name supplier,s.id supplier_id
                           FROM payment_request_lines l JOIN invoices i ON i.id=l.invoice_id JOIN suppliers s ON s.id=i.supplier_id
                           WHERE l.request_id=? ORDER BY s.name,i.doc_date""", (rid,))
    for l in r["lines"]:
        l["paid"] = paid(c, l["invoice_id"], rid); l["due_now"] = due(c, l["invoice_id"])
        l["reste_a_payer"] = max(0, min((l["approved"] if l["approved"] is not None else l["requested"]) - l["paid"], l["due_now"]))
    r["payments"] = rows(c, """SELECT p.*,i.number invoice_number,s.name supplier,u.display_name by_name,x.reason cancel_reason,x.at cancelled_at
                              FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN suppliers s ON s.id=i.supplier_id JOIN users u ON u.id=p.confirmed_by
                              LEFT JOIN payment_cancellations x ON x.payment_id=p.id WHERE p.request_id=? ORDER BY p.id""", (rid,))
    r["history"] = rows(c, "SELECT h.revision,h.event,h.at,u.display_name who FROM payment_request_revisions h JOIN users u ON u.id=h.user_id WHERE request_id=? ORDER BY h.id", (rid,))
    r["total_requested"] = sum(l["requested"] for l in r["lines"])
    r["total_approved"] = sum(l["approved"] or 0 for l in r["lines"]) if r["status"] not in ("brouillon", "soumise", "a_corriger", "refusee") else None
    r["total_paid"] = sum(l["paid"] for l in r["lines"])
    r["total_old"] = sum(l["requested"] for l in r["lines"] if l["is_old"])
    return r


# ---------------------------------------------------------------- inventaires
def save_inventory(c, u, d):
    iid = intid(d, "id", required=False)
    if iid:
        inv = one(c, "SELECT * FROM inventories WHERE id=?", (iid,))
        if not inv or inv["status"] != "brouillon": raise Err("Inventaire non modifiable", 409)
        if inv["created_by"] != u["id"] and u["role"] != "direction": raise Err("Inventaire d'un autre utilisateur", 403)
    else:
        c.execute("INSERT INTO inventories(status,note,created_by,created_at) VALUES('brouillon',?,?,?)", (text(d, "note", 300, False), u["id"], now()))
        iid = val(c, "SELECT last_insert_rowid()")
    for x in d.get("lines") or []:
        it = get_item(c, intid(x, "item_id", "Article"), active_only=False)
        if x.get("counted") in (None, ""):
            c.execute("DELETE FROM inventory_lines WHERE inventory_id=? AND item_id=?", (iid, it["id"])); continue
        milli = 0 if qty_milli(x.get("counted"), "Quantité comptée", allow_zero=True) == 0 else to_base(c, it, x.get("counted"), x.get("unit"))[3]
        c.execute("""INSERT INTO inventory_lines(inventory_id,item_id,expected,counted,reason,counted_at) VALUES(?,?,?,?,?,?)
                     ON CONFLICT(inventory_id,item_id) DO UPDATE SET expected=excluded.expected,counted=excluded.counted,reason=excluded.reason,counted_at=excluded.counted_at""",
                  (iid, it["id"], it["qty"], milli, text(x, "reason", 200, False), now()))
    if d.get("note") is not None: c.execute("UPDATE inventories SET note=? WHERE id=?", (text(d, "note", 300, False), iid))
    if d.get("submit"):
        n = val(c, "SELECT COUNT(*) FROM inventory_lines WHERE inventory_id=?", (iid,))
        if not n: raise Err("Inventaire vide")
        missing = val(c, "SELECT COUNT(*) FROM inventory_lines WHERE inventory_id=? AND counted<>expected AND reason=''", (iid,))
        if missing: raise Err(f"{missing} écart(s) sans explication : indiquez la raison de chaque écart")
        c.execute("UPDATE inventories SET status='soumis',submitted_at=? WHERE id=?", (now(), iid))
        audit(c, u["id"], "inventaire_soumis", "inventory", iid, {"lignes": n})
    else:
        audit(c, u["id"], "inventaire_enregistre", "inventory", iid)
    return {"id": iid}


def review_inventory(c, u, d):
    need(u, "direction")
    iid = intid(d, "inventory_id"); action = d.get("action")
    inv = one(c, "SELECT * FROM inventories WHERE id=?", (iid,))
    if not inv or inv["status"] != "soumis": raise Err("Inventaire non soumis", 409)
    if action == "rejeter":
        c.execute("UPDATE inventories SET status='rejete',reviewed_by=?,reviewed_at=?,review_comment=? WHERE id=?", (u["id"], now(), text(d, "comment", 300, label="Commentaire"), iid))
    elif action == "approuver":
        for l in rows(c, "SELECT * FROM inventory_lines WHERE inventory_id=?", (iid,)):
            delta = l["counted"] - l["expected"]
            v = move(c, u, l["item_id"], "ajustement", delta, None, None, "inventory", iid, allow_clamp=True) if delta else 0
            c.execute("UPDATE inventory_lines SET applied_delta=?,applied_value=? WHERE id=?", (delta, v, l["id"]))
        c.execute("UPDATE inventories SET status='approuve',reviewed_by=?,reviewed_at=?,review_comment=? WHERE id=?", (u["id"], now(), text(d, "comment", 300, False), iid))
    else: raise Err("Action inconnue")
    audit(c, u["id"], "inventaire_" + action, "inventory", iid)
    return {"ok": True}


def inventory_detail(c, iid):
    inv = one(c, "SELECT v.*,u.display_name author,r.display_name reviewer FROM inventories v JOIN users u ON u.id=v.created_by LEFT JOIN users r ON r.id=v.reviewed_by WHERE v.id=?", (iid,))
    if not inv: raise Err("Inventaire inconnu", 404)
    inv["lines"] = rows(c, "SELECT l.*,i.name,i.base_unit,i.qty current_qty,CASE WHEN i.qty>0 THEN 1.0*i.value/i.qty ELSE i.last_cost/1000.0 END avg FROM inventory_lines l JOIN items i ON i.id=l.item_id WHERE inventory_id=? ORDER BY i.category,i.name", (iid,))
    for l in inv["lines"]:
        l["delta"] = l["counted"] - l["expected"]
        l["delta_value"] = l["applied_value"] if l["applied_value"] is not None else int(round(l["delta"] * l["avg"]))
        l["moved_since"] = l["current_qty"] != l["expected"] and inv["status"] in ("brouillon", "soumis")
    return inv


# ---------------------------------------------------------------- justificatifs
MAGIC = [(b"\xff\xd8\xff", "image/jpeg", "jpg"), (b"\x89PNG\r\n\x1a\n", "image/png", "png"), (b"%PDF-", "application/pdf", "pdf")]
OWNERS = {"reception": "receipts", "facture": "invoices", "avoir": "credit_notes", "paiement": "payments", "sortie": "issue_slips", "inventaire": "inventories", "demande": "payment_requests"}


def save_attachment(c, u, d):
    ot = d.get("owner_type")
    if ot not in OWNERS: raise Err("Type de pièce inconnu")
    if ot == "paiement": need(u, "direction")
    oid = intid(d, "owner_id")
    if not one(c, f"SELECT id FROM {OWNERS[ot]} WHERE id=?", (oid,)): raise Err("Document introuvable", 404)
    try: raw = base64.b64decode(str(d.get("data", "")), validate=True)
    except Exception: raise Err("Fichier illisible")
    if not raw: raise Err("Fichier vide")
    if len(raw) > 12 * 1024 * 1024: raise Err("Fichier trop lourd (12 Mo maximum)")
    kind = next(((m, e) for sig, m, e in MAGIC if raw.startswith(sig)), None)
    if not kind and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP": kind = ("image/webp", "webp")
    if not kind: raise Err("Format accepté : photo JPEG/PNG/WEBP ou PDF")
    sha = hashlib.sha256(raw).hexdigest()
    rel = f"justificatifs/{date.today():%Y/%m}/{sha[:16]}.{kind[1]}"
    p = D.DATA / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    if not p.exists():
        tmp = p.with_suffix(".tmp"); tmp.write_bytes(raw); tmp.replace(p)
    name = re.sub(r"[^\w .()-]", "_", text(d, "filename", 120, False) or f"piece.{kind[1]}")[:120]
    c.execute("INSERT INTO attachments(owner_type,owner_id,filename,mime,size,sha256,path,uploaded_by,uploaded_at) VALUES(?,?,?,?,?,?,?,?,?)",
              (ot, oid, name, kind[0], len(raw), sha, rel, u["id"], now()))
    aid = val(c, "SELECT last_insert_rowid()")
    audit(c, u["id"], "justificatif_ajoute", ot, oid, {"attachment": aid, "sha256": sha, "size": len(raw)})
    return {"id": aid}


def attachments_for(c, ot, oid):
    return rows(c, "SELECT a.id,a.filename,a.mime,a.size,a.uploaded_at,u.display_name who FROM attachments a JOIN users u ON u.id=a.uploaded_by WHERE owner_type=? AND owner_id=? ORDER BY a.id", (ot, oid))


# ---------------------------------------------------------------- rapports
def report(c, d):
    kind = d.get("period", "semaine")
    ref = day(d, "date", "Date", default=date.today().isoformat())
    if kind == "mois":
        s0 = date.fromisoformat(ref).replace(day=1)
        e0 = (s0.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
        start, end = s0.isoformat(), e0.isoformat()
    elif kind == "libre":
        start, end = day(d, "start", "Début"), day(d, "end", "Fin")
        if end < start: raise Err("La fin doit être après le début")
    else:
        kind = "semaine"; start, end = week_bounds(c, ref)
    e_ts = end + " 23:59:59"; s_ts = start + " 00:00:00"
    R = {"period": kind, "start": start, "end": end}
    R["achats"] = rows(c, """SELECT s.name supplier, COUNT(*) nb, SUM(r.total) total FROM receipts r JOIN suppliers s ON s.id=r.supplier_id
                            WHERE r.status='validee' AND r.doc_date BETWEEN ? AND ? GROUP BY s.id ORDER BY total DESC""", (start, end))
    R["factures"] = rows(c, """SELECT s.name supplier, COUNT(*) nb, SUM(i.amount) total FROM invoices i JOIN suppliers s ON s.id=i.supplier_id
                              WHERE i.status='active' AND i.kind='facture' AND i.doc_date BETWEEN ? AND ? GROUP BY s.id ORDER BY total DESC""", (start, end))
    R["paiements"] = rows(c, """SELECT s.name supplier, p.mode, COUNT(*) nb, SUM(p.amount) total FROM payments p JOIN invoices i ON i.id=p.invoice_id
                               JOIN suppliers s ON s.id=i.supplier_id LEFT JOIN payment_cancellations x ON x.payment_id=p.id
                               WHERE x.payment_id IS NULL AND p.paid_on BETWEEN ? AND ? GROUP BY s.id,p.mode ORDER BY s.name""", (start, end))
    cons = rows(c, """SELECT m.service, SUM(-m.value) total FROM stock_movements m WHERE m.kind IN ('sortie','retour_service')
                     AND m.created_at BETWEEN ? AND ? GROUP BY m.service""", (s_ts, e_ts))
    R["consommation"] = [{"service": k, "label": v, "total": next((x["total"] for x in cons if x["service"] == k), 0)} for k, v in SERVICES.items()]
    R["consommation_articles"] = rows(c, """SELECT i.name item,i.base_unit unit,m.service,SUM(-m.qty) qty,SUM(-m.value) total FROM stock_movements m JOIN items i ON i.id=m.item_id
                                         WHERE m.kind IN ('sortie','retour_service') AND m.created_at BETWEEN ? AND ? GROUP BY i.id,m.service ORDER BY i.name,m.service""", (s_ts, e_ts))
    R["pertes"] = rows(c, """SELECT i.name item,i.base_unit unit,m.kind,SUM(-m.qty) qty,SUM(-m.value) total FROM stock_movements m JOIN items i ON i.id=m.item_id
                            WHERE m.kind IN ('perte','retour_fournisseur') AND m.created_at BETWEEN ? AND ? GROUP BY i.id,m.kind ORDER BY total DESC""", (s_ts, e_ts))
    R["ecarts"] = rows(c, """SELECT i.name item,i.base_unit unit,SUM(m.qty) qty,SUM(m.value) total FROM stock_movements m JOIN items i ON i.id=m.item_id
                            WHERE m.kind='ajustement' AND m.created_at BETWEEN ? AND ? GROUP BY i.id ORDER BY ABS(SUM(m.value)) DESC""", (s_ts, e_ts))
    debt = []
    for s in rows(c, "SELECT id,name FROM suppliers ORDER BY name"):
        inv = val(c, "SELECT COALESCE(SUM(amount),0) FROM invoices WHERE supplier_id=? AND status='active' AND doc_date<=?", (s["id"], end))
        cr = val(c, "SELECT COALESCE(SUM(c.amount),0) FROM credit_notes c JOIN invoices i ON i.id=c.invoice_id WHERE i.supplier_id=? AND i.status='active' AND c.doc_date<=?", (s["id"], end))
        pd = val(c, """SELECT COALESCE(SUM(p.amount),0) FROM payments p JOIN invoices i ON i.id=p.invoice_id LEFT JOIN payment_cancellations x ON x.payment_id=p.id
                      WHERE x.payment_id IS NULL AND i.supplier_id=? AND i.status='active' AND p.paid_on<=?""", (s["id"], end))
        if inv - cr - pd: debt.append({"supplier": s["name"], "total": inv - cr - pd})
    R["dettes"] = debt
    R["stock_debut"] = val(c, "SELECT COALESCE(SUM(value),0) FROM stock_movements WHERE created_at<?", (s_ts,))
    R["stock_fin"] = val(c, "SELECT COALESCE(SUM(value),0) FROM stock_movements WHERE created_at<=?", (e_ts,))
    R["entrees_stock"] = val(c, "SELECT COALESCE(SUM(value),0) FROM stock_movements WHERE kind IN ('reception','annulation_reception') AND created_at BETWEEN ? AND ?", (s_ts, e_ts))
    R["alertes"] = rows(c, "SELECT name,base_unit unit,qty,min_qty FROM items WHERE active=1 AND min_qty>0 AND qty<=min_qty ORDER BY name")
    R["totaux"] = {
        "achats": sum(x["total"] for x in R["achats"]), "factures": sum(x["total"] for x in R["factures"]),
        "paiements": sum(x["total"] for x in R["paiements"]), "consommation": sum(x["total"] for x in R["consommation"]),
        "pertes": sum(x["total"] for x in R["pertes"]), "ecarts": sum(x["total"] for x in R["ecarts"]), "dettes": sum(x["total"] for x in debt)}
    # contrôle : stock début + entrées − consommation − pertes + écarts = stock fin
    R["controle"] = R["stock_debut"] + R["entrees_stock"] - R["totaux"]["consommation"] - R["totaux"]["pertes"] + R["totaux"]["ecarts"] - R["stock_fin"]
    return R


def dashboard(c, u):
    today = date.today().isoformat()
    ws, we = week_bounds(c, today)
    rep = report(c, {"period": "semaine", "date": today})
    return {
        "stock_value": val(c, "SELECT COALESCE(SUM(value),0) FROM items"),
        "nb_items": val(c, "SELECT COUNT(*) FROM items WHERE active=1"),
        "alertes": rep["alertes"], "semaine": {"start": ws, "end": we, "achats": rep["totaux"]["achats"], "consommation": rep["consommation"],
                                               "paiements": rep["totaux"]["paiements"], "pertes": rep["totaux"]["pertes"]},
        "dette_totale": sum(x["due"] for x in invoices_payable(c)),
        "demandes": rows(c, "SELECT status,COUNT(*) n FROM payment_requests WHERE status IN ('brouillon','soumise','a_corriger','approuvee','partiellement_payee') GROUP BY status"),
        "inventaires_a_valider": val(c, "SELECT COUNT(*) FROM inventories WHERE status='soumis'"),
        "factures_sans_bon": val(c, "SELECT COUNT(*) FROM invoices i WHERE status='active' AND kind='facture' AND NOT EXISTS(SELECT 1 FROM invoice_receipts WHERE invoice_id=i.id)"),
        "bons_sans_facture": val(c, "SELECT COUNT(*) FROM receipts r WHERE status='validee' AND NOT EXISTS(SELECT 1 FROM invoice_receipts WHERE receipt_id=r.id)"),
    }
