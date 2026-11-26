#!/usr/bin/env python3
"""Serveur du logiciel de stocks La Maison Blanche (Python 3.10+, sans dépendance).

  py server.py                                  démarre (réglages dans data/config.json)
  py server.py --host 0.0.0.0 --port 8765 --cert data/tls/serveur.crt --key data/tls/serveur.key
  py server.py creer-compte IDENTIFIANT magasinier|direction "Nom affiché"
  py server.py verifier-journal                contrôle la chaîne d'intégrité du journal

Le serveur refuse d'écouter sur le réseau sans TLS (HTTPS).
"""
import argparse, base64, getpass, ipaddress, json, mimetypes, os, re, ssl, sys, threading, time, traceback
from datetime import date, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import stockdb as D
import metier as M
import documents as DOC
import backup as B
import majlogiciel as MAJ
import controle as CTL
from stockdb import rows, one, val

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
VERSION = (ROOT / "VERSION").read_text().strip() if (ROOT / "VERSION").exists() else "1.0.0"
FAILS = {}; FAIL_LOCK = threading.Lock()
LOCK_SECONDS = 120  # blocage de 2 minutes après 5 essais ratés

def debloquer(username):
    with FAIL_LOCK: FAILS.pop("u:" + str(username).strip().lower(), None)

M.UNLOCK_HOOK = debloquer
LOG_LOCK = threading.Lock()
NETWORKS = []
# Appareils de la direction reliés par Tailscale (SRV MB lui-même y apparaît sous le nom « srv-mb » depuis le 25/11/2026)
TAILSCALE = [ipaddress.ip_network("100.64.0.0/10"), ipaddress.ip_network("fd7a:115c:a1e0::/48")]
BACKUP_STATE = {"last": None, "error": None}


def log(msg):
    line = f"{datetime.now():%Y-%m-%d %H:%M:%S} {msg}"
    with LOG_LOCK:
        try:
            (D.DATA / "journaux").mkdir(parents=True, exist_ok=True)
            with open(D.DATA / "journaux" / f"serveur-{date.today():%Y-%m}.log", "a", encoding="utf-8") as f: f.write(line + "\n")
        except OSError: pass
    print(line, flush=True)


# ------------------------------------------------------------------ routes POST (écriture)
POST = {
    "/api/fournisseur": M.save_supplier,
    "/api/article": M.save_item,
    "/api/reception": M.create_receipt,
    "/api/reception/annuler": M.cancel_receipt,
    "/api/mouvement": M.create_issue,
    "/api/facture": M.create_invoice,
    "/api/facture/rapprocher": M.invoice_link,
    "/api/facture/annuler": M.cancel_invoice,
    "/api/avoir": M.create_credit,
    "/api/demande": M.save_request,
    "/api/demande/soumettre": M.submit_request,
    "/api/demande/abandonner": M.delete_draft,
    "/api/demande/annuler": M.cancel_request,
    "/api/demande/decision": M.review_request,
    "/api/demande/cloturer": M.close_request,
    "/api/paiement": M.confirm_payment,
    "/api/paiement/annuler": M.cancel_payment,
    "/api/inventaire": M.save_inventory,
    "/api/inventaire/decision": M.review_inventory,
    "/api/justificatif": M.save_attachment,
    "/api/compte": M.admin_user,
    "/api/mot-de-passe": M.change_password,
}


def r_settings(c, u, d):
    M.need(u, "direction")
    ws = str(d.get("week_start", ""))
    if ws not in [str(i) for i in range(7)]: raise M.Err("Jour de début de semaine invalide")
    c.execute("UPDATE settings SET value=? WHERE key='week_start'", (ws,))
    D.audit(c, u["id"], "reglages", "settings", None, {"week_start": ws})
    return {"ok": True}


POST["/api/reglages"] = r_settings


# ------------------------------------------------------------------ lectures
def q1(q, k, default=None):
    v = q.get(k)
    return v[0] if v else default


def items_full(c):
    its = rows(c, "SELECT * FROM items ORDER BY category,name")
    units = {}
    for x in rows(c, "SELECT * FROM item_units ORDER BY id"): units.setdefault(x["item_id"], []).append({"name": x["name"], "factor": x["factor"]})
    for i in its:
        i["units"] = [{"name": k, "factor": f} for k, f in D.STD_UNITS[i["base_unit"]].items()] + units.get(i["id"], [])
        i["custom_units"] = units.get(i["id"], [])
        i["avg_cost"] = i["value"] * 1000 / i["qty"] if i["qty"] else i["last_cost"]
    return its


def get_routes(c, u, path, q):
    if path == "/api/session":
        return {"user": {k: u[k] for k in ("id", "username", "display_name", "role", "must_change")}, "version": VERSION,
                "settings": {"week_start": int(D.setting(c, "week_start"))}, "services": D.SERVICES, "issue_kinds": M.ISSUE_KINDS, "pay_modes": DOC.MODES,
                "base_units": D.BASE_UNITS, "pdf": bool(DOC.find_browser()), "today": date.today().isoformat()}
    if path == "/api/referentiel":
        return {"suppliers": rows(c, "SELECT * FROM suppliers ORDER BY name"), "items": items_full(c)}
    if path == "/api/tableau":
        return M.dashboard(c, u)
    if path == "/api/receptions":
        sql = "SELECT r.*,s.name supplier,u.display_name who,(SELECT i.number FROM invoice_receipts ir JOIN invoices i ON i.id=ir.invoice_id WHERE ir.receipt_id=r.id AND i.status='active') invoice FROM receipts r JOIN suppliers s ON s.id=r.supplier_id JOIN users u ON u.id=r.created_by WHERE 1=1"
        args = []
        if q1(q, "supplier"): sql += " AND r.supplier_id=?"; args.append(q1(q, "supplier"))
        if q1(q, "start"): sql += " AND r.doc_date>=?"; args.append(q1(q, "start"))
        if q1(q, "end"): sql += " AND r.doc_date<=?"; args.append(q1(q, "end"))
        if q1(q, "sans_facture"): sql += " AND r.status='validee' AND NOT EXISTS(SELECT 1 FROM invoice_receipts ir JOIN invoices i ON i.id=ir.invoice_id WHERE ir.receipt_id=r.id AND i.status='active')"
        if q1(q, "q"): sql += " AND (r.number LIKE ? OR s.name LIKE ?)"; args += ["%" + q1(q, "q") + "%"] * 2
        return rows(c, sql + " ORDER BY r.doc_date DESC,r.id DESC LIMIT 500", args)
    m = re.fullmatch(r"/api/reception/(\d+)", path)
    if m:
        r = one(c, "SELECT r.*,s.name supplier,u.display_name who FROM receipts r JOIN suppliers s ON s.id=r.supplier_id JOIN users u ON u.id=r.created_by WHERE r.id=?", (m[1],))
        if not r: raise M.Err("Bon introuvable", 404)
        r["lines"] = rows(c, "SELECT l.*,i.name,i.base_unit FROM receipt_lines l JOIN items i ON i.id=l.item_id WHERE receipt_id=? ORDER BY l.id", (m[1],))
        r["misc_lines"] = rows(c, "SELECT * FROM receipt_misc_lines WHERE receipt_id=? ORDER BY id", (m[1],))
        r["invoices"] = rows(c, "SELECT i.id,i.number,i.amount,i.status FROM invoice_receipts ir JOIN invoices i ON i.id=ir.invoice_id WHERE ir.receipt_id=?", (m[1],))
        r["attachments"] = M.attachments_for(c, "reception", int(m[1]))
        return r
    if path == "/api/mouvements":
        sql = "SELECT x.*,u.display_name who,s.name supplier FROM issue_slips x JOIN users u ON u.id=x.created_by LEFT JOIN suppliers s ON s.id=x.supplier_id WHERE 1=1"
        args = []
        for k, col in (("kind", "x.kind"), ("service", "x.service")):
            if q1(q, k): sql += f" AND {col}=?"; args.append(q1(q, k))
        if q1(q, "start"): sql += " AND x.created_at>=?"; args.append(q1(q, "start"))
        if q1(q, "end"): sql += " AND x.created_at<=?"; args.append(q1(q, "end") + " 23:59:59")
        out = rows(c, sql + " ORDER BY x.id DESC LIMIT 500", args)
        for s in out:
            s["lines"] = rows(c, "SELECT i.name,i.base_unit,m.qty,m.value FROM stock_movements m JOIN items i ON i.id=m.item_id WHERE ref_type='issue' AND ref_id=?", (s["id"],))
        return out
    m = re.fullmatch(r"/api/article/(\d+)/historique", path)
    if m:
        return rows(c, "SELECT m.*,u.display_name who FROM stock_movements m JOIN users u ON u.id=m.created_by WHERE item_id=? ORDER BY m.id DESC LIMIT 300", (m[1],))
    if path == "/api/factures":
        sql = "SELECT i.*,s.name supplier FROM invoices i JOIN suppliers s ON s.id=i.supplier_id WHERE 1=1"; args = []
        if q1(q, "supplier"): sql += " AND i.supplier_id=?"; args.append(q1(q, "supplier"))
        if q1(q, "q"): sql += " AND (i.number LIKE ? OR s.name LIKE ?)"; args += ["%" + q1(q, "q") + "%"] * 2
        out = rows(c, sql + " ORDER BY i.doc_date DESC,i.id DESC LIMIT 500", args)
        locked = M.locked_invoices(c)
        for i in out:
            i["due"] = M.due(c, i["id"]); i["paid"] = M.paid(c, i["id"]); i["locked_by"] = locked.get(i["id"])
            i["credits"] = val(c, "SELECT COALESCE(SUM(amount),0) FROM credit_notes WHERE invoice_id=?", (i["id"],))
            rec = M.reconcile(c, i["id"]); i["nb_bons"] = len(rec["bons"]); i["ecart"] = rec["ecart"]
        if q1(q, "etat") == "dues": out = [i for i in out if i["due"] > 0]
        return out
    m = re.fullmatch(r"/api/facture/(\d+)", path)
    if m:
        i = one(c, "SELECT i.*,s.name supplier,u.display_name who FROM invoices i JOIN suppliers s ON s.id=i.supplier_id JOIN users u ON u.id=i.created_by WHERE i.id=?", (m[1],))
        if not i: raise M.Err("Facture introuvable", 404)
        i.update(M.reconcile(c, i["id"]))
        i["due"] = M.due(c, i["id"]); i["paid"] = M.paid(c, i["id"])
        i["credits"] = rows(c, "SELECT * FROM credit_notes WHERE invoice_id=?", (m[1],))
        i["payments"] = rows(c, "SELECT p.*,r.number request,x.reason cancel_reason FROM payments p JOIN payment_requests r ON r.id=p.request_id LEFT JOIN payment_cancellations x ON x.payment_id=p.id WHERE invoice_id=?", (m[1],))
        i["requests"] = rows(c, "SELECT r.id,r.number,r.status,l.requested,l.approved FROM payment_request_lines l JOIN payment_requests r ON r.id=l.request_id WHERE l.invoice_id=?", (m[1],))
        i["attachments"] = M.attachments_for(c, "facture", int(m[1]))
        return i
    if path == "/api/a-payer":
        ex = q1(q, "exclure")
        return M.invoices_payable(c, int(ex) if ex and ex.isdigit() else None)
    if path == "/api/demandes":
        out = rows(c, "SELECT r.*,u.display_name author FROM payment_requests r JOIN users u ON u.id=r.created_by WHERE NOT (r.status='cloturee' AND r.revision=0) ORDER BY r.id DESC LIMIT 200")
        for r in out:
            r["total"] = val(c, "SELECT COALESCE(SUM(requested),0) FROM payment_request_lines WHERE request_id=?", (r["id"],))
            r["approved_total"] = val(c, "SELECT COALESCE(SUM(approved),0) FROM payment_request_lines WHERE request_id=?", (r["id"],))
            r["paid_total"] = val(c, "SELECT COALESCE(SUM(p.amount),0) FROM payments p LEFT JOIN payment_cancellations x ON x.payment_id=p.id WHERE x.payment_id IS NULL AND p.request_id=?", (r["id"],))
            r["nb"] = val(c, "SELECT COUNT(*) FROM payment_request_lines WHERE request_id=?", (r["id"],))
        return out
    m = re.fullmatch(r"/api/demande/(\d+)", path)
    if m:
        r = M.request_detail(c, int(m[1])); r["attachments"] = M.attachments_for(c, "demande", int(m[1])); return r
    if path == "/api/inventaires":
        return rows(c, "SELECT v.*,u.display_name author,(SELECT COUNT(*) FROM inventory_lines WHERE inventory_id=v.id) nb,(SELECT COUNT(*) FROM inventory_lines WHERE inventory_id=v.id AND counted<>expected) ecarts FROM inventories v JOIN users u ON u.id=v.created_by ORDER BY v.id DESC LIMIT 200")
    m = re.fullmatch(r"/api/inventaire/(\d+)", path)
    if m: return M.inventory_detail(c, int(m[1]))
    if path == "/api/rapport": return M.report(c, {k: v[0] for k, v in q.items()})
    if path == "/api/journal":
        M.need(u, "direction")
        ok, bad = D.verify_audit_chain(c)
        return {"integre": ok, "rupture": bad, "entries": rows(c, "SELECT a.*,u.display_name who FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 500")}
    if path == "/api/comptes":
        M.need(u, "direction")
        return rows(c, "SELECT id,username,display_name,role,active,must_change,created_at,(SELECT MAX(last_seen) FROM sessions WHERE user_id=users.id) last_seen FROM users ORDER BY role,username")
    if path == "/api/sauvegardes":
        M.need(u, "direction")
        return {"list": B.listing(backup_dirs())[:60], "state": BACKUP_STATE, "dirs": [str(x) for x in backup_dirs()]}
    if path == "/api/mise-a-jour":
        M.need(u, "direction")
        if q.get("verifier"): MAJ.version_disponible()
        return MAJ.etat()
    if path == "/api/sante":
        M.need(u, "direction")
        return dict(sante_now(c), mise_a_jour_refusee=MAJ.ETAT.get("refusee"))
    raise M.Err("Page inconnue", 404)


DOCS = {"demande": DOC.doc_request, "sortie": DOC.doc_issue, "reception": DOC.doc_receipt, "inventaire": DOC.doc_inventory}


# ------------------------------------------------------------------ sauvegardes automatiques
def load_config():
    p = D.DATA / "config.json"
    try: return json.loads(p.read_text(encoding="utf-8-sig")) if p.exists() else {}
    except ValueError: return {}


def backup_dirs():
    cfg = load_config()
    dirs = [D.DATA / "sauvegardes"] + [Path(x) for x in cfg.get("sauvegardes_externes", [])]
    return dirs


def run_backup(label="auto"):
    try:
        res = B.create(backup_dirs(), label)
        BACKUP_STATE["last"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        errs = [f for f in res["files"] if f.startswith("ÉCHEC")]
        BACKUP_STATE["error"] = "; ".join(errs) or None
        log("Sauvegarde : " + " | ".join(res["files"]))
        return res
    except Exception as e:
        BACKUP_STATE["error"] = str(e); log("ÉCHEC sauvegarde : " + str(e)); raise


def sante_now(c):
    lst = B.listing([D.DATA / "sauvegardes"])
    return CTL.sante(c, lst[0]["date"] if lst else None)


def sante_loop():
    """Contrôle de santé 2 minutes après le démarrage puis toutes les 6 heures : tout problème est noté dans le journal."""
    time.sleep(120)
    while True:
        try:
            c = D.connect()
            try: r = sante_now(c)
            finally: c.close()
            if not r["ok"]: log("ALERTE santé : " + " | ".join(r["problemes"]))
        except Exception as e: log("Contrôle de santé impossible : " + str(e))
        time.sleep(6 * 3600)


CLIENT_ERRS = []


def backup_loop():
    """Sauvegarde au démarrage si la dernière a plus de 12 h, puis toutes les 6 h et chaque soir à 23 h 30."""
    time.sleep(20)
    done_today = None
    while True:
        try:
            lst = B.listing([D.DATA / "sauvegardes"])
            last = datetime.strptime(lst[0]["date"], "%Y-%m-%d %H:%M") if lst else None
            n = datetime.now()
            if not last or (n - last).total_seconds() > 6 * 3600 or (n.hour == 23 and n.minute >= 30 and done_today != n.date()):
                run_backup("auto"); done_today = n.date() if n.hour == 23 else done_today
        except Exception: pass
        time.sleep(300)


# ------------------------------------------------------------------ HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = "MBStocks"; sys_version = ""
    protocol_version = "HTTP/1.1"

    def log_message(self, *a): pass

    def headers_common(self, ctype, length, extra=None):
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src 'self' blob:; object-src 'self' blob:; frame-ancestors 'self'")
        if isinstance(self.connection, ssl.SSLSocket): self.send_header("Strict-Transport-Security", "max-age=31536000")
        for k, v in (extra or {}).items(): self.send_header(k, v)

    def out(self, status, body, ctype="application/json; charset=utf-8", extra=None):
        if not isinstance(body, (bytes, bytearray)): body = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status); self.headers_common(ctype, len(body), extra); self.end_headers()
        if self.command != "HEAD": self.wfile.write(body)

    def allowed(self):
        try: ip = ipaddress.ip_address(self.client_address[0])
        except ValueError: return False
        return any(ip in n for n in NETWORKS)

    def token(self):
        h = self.headers.get("Authorization", "")
        return h[7:].strip() if h.startswith("Bearer ") else None

    def handle_one_request(self):
        try: super().handle_one_request()
        except (ConnectionError, ssl.SSLError, TimeoutError): self.close_connection = True

    def do_GET(self): self.dispatch("GET")
    def do_POST(self): self.dispatch("POST")
    def do_HEAD(self): self.dispatch("GET")

    def dispatch(self, method):
        try:
            if not self.allowed(): return self.out(403, {"erreur": "Poste non autorisé"})
            url = urlparse(self.path); path = url.path; q = parse_qs(url.query)
            if method == "GET" and not path.startswith("/api/"): return self.static(path)
            if method == "POST":
                origin = self.headers.get("Origin")
                if origin and urlparse(origin).netloc != self.headers.get("Host"): raise M.Err("Origine refusée", 403)
                n = int(self.headers.get("Content-Length") or 0)
                limit = 20_000_000 if path == "/api/justificatif" else 2_000_000
                if n <= 0 or n > limit: raise M.Err("Données trop volumineuses ou absentes", 413)
                if "application/json" not in (self.headers.get("Content-Type") or ""): raise M.Err("Format JSON attendu", 415)
                d = json.loads(self.rfile.read(n))
                if not isinstance(d, dict): raise M.Err("Objet JSON attendu")
            else: d = {}
            if path == "/api/connexion" and method == "POST": return self.out(200, self.login(d))
            if path == "/api/ping": return self.out(200, {"ok": True, "version": VERSION, "heure": D.now()})
            c = D.connect()
            try:
                u = M.session_user(c, self.token())
                if not u: raise M.Err("Session expirée : reconnectez-vous", 401, "session")
                c.execute("UPDATE sessions SET last_seen=? WHERE token_hash=?", (D.now(), u["token_hash"]))
                if method == "POST":
                    if path == "/api/deconnexion":
                        c.execute("DELETE FROM sessions WHERE token_hash=?", (u["token_hash"],)); return self.out(200, {"ok": True})
                    if path == "/api/sauvegarde":
                        M.need(u, "direction"); res = run_backup("manuelle")
                        return self.out(200, {"files": res["files"]})
                    if path == "/api/mise-a-jour":
                        M.need(u, "direction")
                        with D.WRITE_LOCK:
                            c.execute("BEGIN IMMEDIATE"); D.audit(c, u["id"], "mise_a_jour", "logiciel", None, {"depuis": VERSION}); c.execute("COMMIT")
                        return self.out(200, MAJ.lancer(log, avant=lambda: run_backup("avant-maj")))
                    if path == "/api/erreur-client":
                        t = time.time(); CLIENT_ERRS[:] = [x for x in CLIENT_ERRS if t - x < 3600]
                        if len(CLIENT_ERRS) < 30:
                            CLIENT_ERRS.append(t)
                            log("ERREUR écran (" + u["username"] + ") " + " | ".join(str(d.get(k, ""))[:400].replace("\n", " ") for k in ("message", "page", "source", "appareil")))
                        return self.out(200, {"ok": True})
                    fn = POST.get(path)
                    if not fn: raise M.Err("Action inconnue", 404)
                    if u["must_change"] and path != "/api/mot-de-passe": raise M.Err("Changez d'abord votre mot de passe provisoire", 403, "must_change")
                    with D.WRITE_LOCK:
                        c.execute("BEGIN IMMEDIATE")
                        try:
                            res = fn(c, u, d); c.execute("COMMIT")
                        except BaseException:
                            c.execute("ROLLBACK"); raise
                    return self.out(200, res)
                m = re.fullmatch(r"/api/justificatif/(\d+)", path)
                if m:
                    a = one(c, "SELECT * FROM attachments WHERE id=?", (m[1],))
                    if not a: raise M.Err("Pièce introuvable", 404)
                    p = (D.DATA / a["path"]).resolve()
                    if D.DATA.resolve() not in p.parents or not p.exists(): raise M.Err("Fichier manquant sur le serveur", 410)
                    return self.out(200, p.read_bytes(), a["mime"], {"Content-Disposition": f"inline; filename=\"piece-{a['id']}{Path(a['path']).suffix}\""})
                m = re.fullmatch(r"/api/(doc|pdf)/(demande|sortie|reception|inventaire|rapport|stock)(?:/(\d+))?", path)
                if m:
                    if m[2] == "rapport": h = DOC.doc_report(c, {k: v[0] for k, v in q.items()})
                    elif m[2] == "stock": h = DOC.doc_stock(c)
                    else:
                        if not m[3]: raise M.Err("Document inconnu", 404)
                        h = DOCS[m[2]](c, int(m[3]))
                    if m[1] == "doc": return self.out(200, h.encode(), "text/html; charset=utf-8")
                    return self.out(200, DOC.to_pdf(h), "application/pdf", {"Content-Disposition": f"attachment; filename=\"{m[2]}-{m[3] or date.today()}.pdf\""})
                m = re.fullmatch(r"/api/export/(\w+)\.csv", path)
                if m:
                    return self.out(200, DOC.export(c, m[1], {k: v[0] for k, v in q.items()}), "text/csv; charset=utf-8",
                                    {"Content-Disposition": f"attachment; filename=\"stocks-{m[1]}-{date.today()}.csv\""})
                return self.out(200, get_routes(c, u, path, q))
            finally: c.close()
        except M.Err as e:
            self.out(e.status, {"erreur": str(e), "code": e.code, **e.extra})
        except json.JSONDecodeError:
            self.out(400, {"erreur": "Données illisibles"})
        except D.sqlite3.IntegrityError as e:
            log(f"Contrainte {self.path} : {e}")
            self.out(409, {"erreur": "Opération refusée : elle créerait un doublon ou une incohérence"})
        except D.sqlite3.OperationalError as e:
            log(f"Base occupée {self.path} : {e}")
            self.out(503, {"erreur": "Base momentanément occupée, réessayez"})
        except (ConnectionError, ssl.SSLError): pass
        except Exception:
            log("ERREUR " + self.path + "\n" + traceback.format_exc())
            try: self.out(500, {"erreur": "Erreur interne : elle a été notée dans le journal du serveur"})
            except Exception: pass

    def login(self, d):
        ip = self.client_address[0]
        name = str(d.get("username", "")).strip().lower()[:60]
        fwd = (self.headers.get("X-Forwarded-For") or "").split(",")[0].strip()[:60]
        key_ip, key_user = "ip:" + (fwd if fwd and ipaddress.ip_address(ip).is_loopback else ip), "u:" + name
        t = time.time()
        with FAIL_LOCK:
            for k in (key_ip, key_user):
                FAILS[k] = [x for x in FAILS.get(k, []) if t - x < LOCK_SECONDS]
            if len(FAILS[key_ip]) >= 20 or len(FAILS[key_user]) >= 5:
                reste = int(LOCK_SECONDS - (t - min(FAILS[key_user] or FAILS[key_ip]))) + 1
                raise M.Err(f"Trop d'essais : réessayez dans {reste} secondes (ou demandez à la direction un nouveau mot de passe)", 429)
        c = D.connect()
        try:
            if d.get("magasinier_direct"):
                # Entrée du magasinier sans mot de passe (demande de la direction, 25/11/2026) :
                # seulement depuis le réseau du restaurant, jamais depuis l'accès à distance Tailscale.
                if self.headers.get("Tailscale-User-Login") or any(ipaddress.ip_address(ip) in n for n in TAILSCALE) or not any(ipaddress.ip_address(ip) in n for n in NETWORKS):
                    raise M.Err("Entrée sans mot de passe possible seulement au restaurant", 403)
                mags = M.rows(c, "SELECT * FROM users WHERE role='magasinier' AND active=1 ORDER BY id")
                if not mags: raise M.Err("Aucun compte magasinier actif", 404)
                u = mags[0]
                with D.WRITE_LOCK:
                    c.execute("BEGIN IMMEDIATE")
                    c.execute("UPDATE users SET must_change=0 WHERE id=?", (u["id"],))
                    tok = M.new_session(c, u["id"], ip)
                    D.audit(c, u["id"], "connexion_sans_mdp", "user", u["id"], {"ip": ip})
                    c.execute("COMMIT")
                return {"token": tok, "role": u["role"], "must_change": 0}
            u = M.authenticate(c, name, str(d.get("password", "")))
            if not u:
                with FAIL_LOCK: FAILS[key_ip].append(t); FAILS[key_user].append(t)
                log(f"Connexion refusée {name} depuis {ip}")
                raise M.Err("Identifiant ou mot de passe incorrect", 401)
            with D.WRITE_LOCK:
                c.execute("BEGIN IMMEDIATE")
                tok = M.new_session(c, u["id"], ip)
                D.audit(c, u["id"], "connexion", "user", u["id"], {"ip": ip})
                c.execute("COMMIT")
            with FAIL_LOCK: FAILS.pop(key_user, None)
            return {"token": tok, "role": u["role"], "must_change": u["must_change"]}
        finally: c.close()

    def static(self, path):
        if path in ("/", "/index.html"): path = "/index.html"
        p = (PUBLIC / path.lstrip("/")).resolve()
        if PUBLIC.resolve() not in p.parents or not p.is_file(): return self.out(404, b"Introuvable", "text/plain; charset=utf-8")
        ctype = {".js": "application/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png"}.get(p.suffix.lower()) or mimetypes.guess_type(p.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",): ctype += "; charset=utf-8"
        self.out(200, p.read_bytes(), ctype)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data"); ap.add_argument("--host"); ap.add_argument("--port", type=int); ap.add_argument("--cert"); ap.add_argument("--key")
    sub = ap.add_subparsers(dest="cmd")
    cu = sub.add_parser("creer-compte"); cu.add_argument("username"); cu.add_argument("role", choices=["magasinier", "direction"]); cu.add_argument("nom", nargs="?")
    cu.add_argument("--mot-de-passe-env", help="lire le mot de passe dans cette variable d'environnement")
    sub.add_parser("verifier-journal")
    a = ap.parse_args()
    if a.data: D.set_paths(a.data)
    D.init()
    if not a.cmd and not os.environ.get("MB_STOCKS_NO_CATALOGUE"):
        c = D.connect()
        try:
            c.execute("BEGIN IMMEDIATE"); n = M.import_catalogue(c, ROOT / "catalogue_initial.json"); nf = M.import_fournisseurs(c); c.execute("COMMIT")
            if n: log(f"Catalogue de départ : {n} articles ajoutés (sans quantité)")
            if nf: log(f"Fournisseurs habituels : {nf} ajoutés")
        except Exception as e:
            c.execute("ROLLBACK"); log(f"Catalogue de départ non importé : {e}")
        finally: c.close()
    cfg = load_config()
    if a.cmd == "creer-compte":
        pw = os.environ.get(a.mot_de_passe_env, "") if a.mot_de_passe_env else getpass.getpass("Mot de passe (10 caractères minimum) : ")
        c = D.connect()
        try:
            c.execute("BEGIN IMMEDIATE"); i = M.create_user(c, a.username, a.nom or a.username, a.role, pw)
            D.audit(c, None, "compte_cree_console", "user", i, {"username": a.username, "role": a.role}); c.execute("COMMIT")
        except M.Err as e: c.execute("ROLLBACK"); sys.exit("ERREUR : " + str(e))
        print("Compte créé :", a.username, a.role); return
    if a.cmd == "verifier-journal":
        c = D.connect(); ok, bad = D.verify_audit_chain(c)
        print("Journal intègre" if ok else f"JOURNAL ALTÉRÉ à partir de l'entrée {bad}"); sys.exit(0 if ok else 1)
    host = a.host or cfg.get("host", "127.0.0.1"); port = a.port or int(cfg.get("port", 8765))
    cert = a.cert or cfg.get("cert"); key = a.key or cfg.get("key")
    if cert and not Path(cert).is_absolute(): cert = str(D.DATA / cert)
    if key and not Path(key).is_absolute(): key = str(D.DATA / key)
    c = D.connect()
    nets = cfg.get("reseaux_autorises") or D.setting(c, "allowed_networks").split(",")
    c.close()
    NETWORKS[:] = [ipaddress.ip_network(n.strip(), strict=False) for n in nets if n.strip()] + [ipaddress.ip_network("127.0.0.0/8"), ipaddress.ip_network("::1/128")] + TAILSCALE
    local = host in ("127.0.0.1", "localhost", "::1")
    if not local and not (cert and key): sys.exit("TLS obligatoire pour un accès réseau : indiquez --cert et --key (voir outils/creer_certificats.py)")
    srv = Server((host, port), Handler)
    if cert and key:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(cert, key); srv.socket = ctx.wrap_socket(srv.socket, server_side=True, do_handshake_on_connect=False)
    if not os.environ.get("MB_STOCKS_NO_BACKUP"): threading.Thread(target=backup_loop, daemon=True).start()
    if not os.environ.get("MB_STOCKS_NO_BACKUP"):
        threading.Thread(target=MAJ.boucle_auto, args=(log,), kwargs={"avant": lambda: run_backup("avant-maj")}, daemon=True).start()
        threading.Thread(target=sante_loop, daemon=True).start()
        try: CTL.garder_version(ROOT, VERSION)  # ce code a démarré : c'est la dernière version qui marche
        except Exception as e: log("Copie de la version en cours impossible : " + str(e))
    log(f"Stocks La Maison Blanche {VERSION} — {'https' if cert else 'http'}://{host}:{port} — données : {D.DATA}")
    reload_flag = threading.Event()
    def watch():  # mise à jour du logiciel : essai de la nouvelle version, puis redémarrage automatique
        files = lambda: [p for p in ROOT.glob("*.py")] + [ROOT / "VERSION"]
        snap = lambda: {str(f): (f.stat().st_mtime, f.stat().st_size) for f in files() if f.exists()}
        old = snap()
        while True:
            time.sleep(5)
            cur = snap()
            if cur == old: continue
            while True:  # attendre que la copie soit vraiment finie (plus aucun changement pendant 6 s)
                time.sleep(6); nxt = snap()
                if nxt == cur: break
                cur = nxt
            ok, msg = CTL.essai(ROOT, D.DB_PATH)
            if snap() != cur: continue  # encore des fichiers en cours de copie : on recommence
            if not ok:
                log("MISE À JOUR REFUSÉE (la version reçue ne démarre pas) : " + msg)
                MAJ.ETAT["refusee"] = datetime.now().strftime("%Y-%m-%d %H:%M") + " — " + msg
                try:
                    if CTL.restaurer_version(ROOT, VERSION): log(f"Version {VERSION} remise en place : le logiciel continue de fonctionner")
                except Exception as e: log("Remise en place impossible : " + str(e))
                old = snap(); continue
            if not os.environ.get("MB_STOCKS_NO_BACKUP"):
                try: run_backup("avant-maj")
                except Exception: pass
            log("Mise à jour vérifiée : redémarrage du serveur"); reload_flag.set(); srv.shutdown(); return
    threading.Thread(target=watch, daemon=True).start()
    try: srv.serve_forever()
    except KeyboardInterrupt: pass
    if reload_flag.is_set():
        srv.server_close()
        if os.name == "nt":
            import subprocess
            subprocess.Popen([sys.executable] + sys.argv, cwd=str(ROOT), creationflags=0x00000008 | 0x00000200)  # DETACHED_PROCESS | NEW_PROCESS_GROUP
            os._exit(0)
        os.execv(sys.executable, [sys.executable] + sys.argv)


if __name__ == "__main__":
    main()
