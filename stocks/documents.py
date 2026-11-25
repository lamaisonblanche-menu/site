"""Documents imprimables (HTML → PDF) et exports CSV."""
import base64, csv, html, io, os, shutil, subprocess, tempfile
from datetime import datetime
from pathlib import Path
import metier as M
from stockdb import rows, one, val, SERVICES

ROOT = Path(__file__).resolve().parent
E = lambda x: html.escape("" if x is None else str(x))
DA = M.fmt_da
STATUS = {"brouillon": "Brouillon", "soumise": "Soumise à la direction", "a_corriger": "À corriger", "refusee": "Refusée",
          "approuvee": "Approuvée — en attente de paiement", "partiellement_payee": "Partiellement payée", "payee": "Payée", "cloturee": "Clôturée",
          "soumis": "Soumis", "approuve": "Approuvé", "rejete": "Rejeté"}
MODES = {"especes": "Espèces", "cheque": "Chèque", "virement": "Virement", "autre": "Autre"}


def fr_date(s):
    if not s: return ""
    try: return datetime.fromisoformat(s.replace(" ", "T")).strftime("%d/%m/%Y" + (" %H:%M" if len(s) > 10 else ""))
    except ValueError: return s


def logo():
    p = ROOT / "public" / "logo.png"
    return "data:image/png;base64," + base64.b64encode(p.read_bytes()).decode() if p.exists() else ""


CSS = """
@page{size:A4;margin:14mm 12mm 16mm}
*{box-sizing:border-box}body{font:10pt/1.35 "Segoe UI","Jost",Arial,sans-serif;color:#111;margin:0}
.head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #111;padding-bottom:8px;margin-bottom:12px}
.head img{height:62px}.head .ttl{text-align:right}.head h1{font:400 18pt "Marcellus","Candara",Georgia,serif;margin:0 0 2px}
.head .sub{color:#555;font-size:9pt}.badge{display:inline-block;border:1px solid #b8955a;color:#7a5f2f;border-radius:20px;padding:1px 9px;font-size:8.5pt;margin-top:4px}
.meta{display:grid;grid-template-columns:repeat(4,1fr);gap:6px 14px;margin:8px 0 12px;font-size:9pt}.meta b{display:block;font-size:7.5pt;color:#73716c;text-transform:uppercase;letter-spacing:.08em;font-weight:500}
h2{font:400 12.5pt "Marcellus","Candara",Georgia,serif;margin:14px 0 6px;border-bottom:1px solid #e2e0db;padding-bottom:3px}
table{width:100%;border-collapse:collapse;font-size:8.8pt;page-break-inside:auto}tr{page-break-inside:avoid}
th{background:#f4f3f0;text-align:left;font-weight:600;padding:5px 6px;border-bottom:1px solid #ccc;font-size:8pt}
td{padding:4px 6px;border-bottom:1px solid #eee;vertical-align:top}.r{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
tr.sub td{background:#faf8f4;font-weight:600;border-bottom:1px solid #ddd}tr.tot td{font-weight:700;border-top:2px solid #111;font-size:9.5pt}
.old{color:#b5651d;font-size:7.5pt;font-weight:600}.muted{color:#73716c}.cancel{text-decoration:line-through;color:#999}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:6px 0 4px}.kpi{border:1px solid #e2e0db;border-radius:6px;padding:7px 9px}
.kpi b{display:block;font-size:7.5pt;color:#73716c;text-transform:uppercase;letter-spacing:.06em;font-weight:500}.kpi span{font-size:12pt;font-weight:600}
.sign{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:22px;page-break-inside:avoid}.sign div{border:1px solid #ccc;border-radius:6px;height:92px;padding:7px;font-size:8.5pt}
.sign div b{display:block;margin-bottom:4px}.note{background:#fbeee0;border-left:3px solid #b5651d;padding:6px 9px;margin:8px 0;font-size:9pt}
.foot{margin-top:14px;border-top:1px solid #e2e0db;padding-top:5px;font-size:7.5pt;color:#73716c;display:flex;justify-content:space-between}
.warn{color:#b3261e;font-weight:600}
"""


def page(title, subtitle, status, meta, body, foot=""):
    m = "".join(f"<div><b>{E(k)}</b>{v}</div>" for k, v in meta)
    st = f'<span class="badge">{E(status)}</span>' if status else ""
    return f"""<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>{E(title)}</title><style>{CSS}</style></head><body>
<div class="head"><img src="{logo()}" alt=""><div class="ttl"><h1>{E(title)}</h1><div class="sub">{E(subtitle)}</div>{st}</div></div>
<div class="meta">{m}</div>{body}
<div class="foot"><span>La Maison Blanche — 23 rue des Frères Ben Ali, Hydra, Alger · Gestion des stocks</span><span>{E(foot)} Édité le {datetime.now():%d/%m/%Y à %H:%M}</span></div>
</body></html>"""


def doc_request(c, rid):
    r = M.request_detail(c, rid)
    approved = r["total_approved"] is not None
    body, sup, sub = [], None, [0, 0, 0, 0]
    head = "<tr><th>Facture</th><th>Date</th><th>Échéance</th><th class=r>Montant facture</th><th class=r>Reste dû (soumission)</th><th class=r>Demandé</th>" + \
           ("<th class=r>Approuvé</th><th class=r>Payé</th>" if approved else "") + "</tr>"
    def subtotal():
        if sup is not None:
            body.append(f"<tr class=sub><td colspan=4>Sous-total {E(sup)}</td><td class=r>{DA(sub[0])}</td><td class=r>{DA(sub[1])}</td>" +
                        (f"<td class=r>{DA(sub[2])}</td><td class=r>{DA(sub[3])}</td>" if approved else "") + "</tr>")
    for l in r["lines"]:
        if l["supplier"] != sup:
            subtotal(); sup = l["supplier"]; sub = [0, 0, 0, 0]
            body.append(f"<tr><td colspan={8 if approved else 6} style='padding-top:9px'><b>{E(sup)}</b></td></tr>")
        sub[0] += l["due_at_submit"]; sub[1] += l["requested"]; sub[2] += l["approved"] or 0; sub[3] += l["paid"]
        old = ' <span class="old">ANCIEN SOLDE</span>' if l["is_old"] else ""
        kind = " (solde initial)" if l["kind"] == "solde_initial" else ""
        body.append(f"<tr><td>{E(l['number'])}{kind}{old}</td><td>{fr_date(l['doc_date'])}</td><td>{fr_date(l['due_date']) or '—'}</td>"
                    f"<td class=r>{DA(l['invoice_amount'])}</td><td class=r>{DA(l['due_at_submit'])}</td><td class=r><b>{DA(l['requested'])}</b></td>" +
                    (f"<td class=r>{DA(l['approved'] or 0)}</td><td class=r>{DA(l['paid'])}</td>" if approved else "") + "</tr>")
    subtotal()
    tot_due = sum(l["due_at_submit"] for l in r["lines"])
    body.append(f"<tr class=tot><td colspan=4>TOTAL</td><td class=r>{DA(tot_due)}</td><td class=r>{DA(r['total_requested'])}</td>" +
                (f"<td class=r>{DA(r['total_approved'])}</td><td class=r>{DA(r['total_paid'])}</td>" if approved else "") + "</tr>")
    kp = [("Montant demandé", DA(r["total_requested"])), ("dont anciens soldes", DA(r["total_old"])),
          ("Approuvé", DA(r["total_approved"]) if approved else "—"), ("Payé (confirmé)", DA(r["total_paid"]))]
    html_ = '<div class="kpis">' + "".join(f'<div class="kpi"><b>{k}</b><span>{v}</span></div>' for k, v in kp) + "</div>"
    if r["status"] in ("soumise", "brouillon", "a_corriger"):
        html_ += '<div class="note">Document de demande : <b>aucun paiement n\'est effectué</b> tant que la direction ne l\'a pas approuvé puis confirmé chaque règlement.</div>'
    elif approved and r["status"] != "payee":
        html_ += '<div class="note">Une approbation n\'est pas un paiement : seuls les règlements listés ci-dessous ont été confirmés par la direction.</div>'
    if r.get("review_comment"): html_ += f'<div class="note"><b>Commentaire de la direction :</b> {E(r["review_comment"])}</div>'
    if r["note"]: html_ += f'<p><b>Note du magasinier :</b> {E(r["note"])}</p>'
    html_ += "<h2>Factures</h2><table>" + head + "".join(body) + "</table>"
    pays = r["payments"]
    if pays:
        html_ += "<h2>Règlements confirmés par la direction</h2><table><tr><th>Date</th><th>Fournisseur</th><th>Facture</th><th>Mode</th><th>Référence</th><th>Confirmé par</th><th class=r>Montant</th></tr>"
        for p in pays:
            cl = ' class="cancel"' if p["cancel_reason"] else ""
            html_ += (f"<tr{cl}><td>{fr_date(p['paid_on'])}</td><td>{E(p['supplier'])}</td><td>{E(p['invoice_number'])}</td><td>{MODES.get(p['mode'], p['mode'])}</td>"
                      f"<td>{E(p['reference'])}</td><td>{E(p['by_name'])}</td><td class=r>{DA(p['amount'])}</td></tr>")
            if p["cancel_reason"]: html_ += f"<tr><td colspan=7 class=warn>Paiement annulé le {fr_date(p['cancelled_at'])} : {E(p['cancel_reason'])}</td></tr>"
        html_ += "</table>"
    html_ += f"""<div class="sign"><div><b>Préparé et soumis par le magasinier</b>{E(r['author'])}<br>{fr_date(r['submitted_at'])}<br><br>Signature :</div>
<div><b>Décision de la direction</b>{E(STATUS.get(r['status'], ''))}<br>{E(r.get('reviewer') or '')} {fr_date(r.get('reviewed_at'))}<br><br>Signature :</div></div>"""
    if r["history"]:
        html_ += "<h2>Historique</h2><table><tr><th>Date</th><th>Révision</th><th>Événement</th><th>Par</th></tr>" + "".join(
            f"<tr><td>{fr_date(h['at'])}</td><td>{h['revision']}</td><td>{E(STATUS.get(h['event'], h['event']))}</td><td>{E(h['who'])}</td></tr>" for h in r["history"]) + "</table>"
    meta = [("N° de demande", E(r["number"])), ("Semaine", f"{fr_date(r['week_start'])} au {fr_date(r['week_end'])}"),
            ("Révision", str(r["revision"])), ("Fournisseurs", str(len({l['supplier_id'] for l in r['lines']})))]
    return page("Demande de paiement fournisseurs", f"{r['number']} — semaine du {fr_date(r['week_start'])}", STATUS.get(r["status"], r["status"]), meta, html_, r["number"] + " ·")


def tbl(head, data, right=()):
    h = "".join(f"<th{' class=r' if i in right else ''}>{E(x)}</th>" for i, x in enumerate(head))
    b = "".join("<tr>" + "".join(f"<td{' class=r' if i in right else ''}>{x}</td>" for i, x in enumerate(r)) + "</tr>" for r in data)
    return f"<table><tr>{h}</tr>{b or '<tr><td colspan=9 class=muted>Aucune donnée sur la période</td></tr>'}</table>"


def doc_report(c, q):
    R = M.report(c, q)
    t = R["totaux"]
    kp = [("Achats reçus (bons)", DA(t["achats"])), ("Factures enregistrées", DA(t["factures"])), ("Paiements effectués", DA(t["paiements"])), ("Dettes fournisseurs (fin)", DA(t["dettes"])),
          ("Consommation services", DA(t["consommation"])), ("Pertes & retours fourn.", DA(t["pertes"])), ("Écarts d'inventaire", DA(t["ecarts"])), ("Valeur du stock (fin)", DA(R["stock_fin"]))]
    h = '<div class="kpis">' + "".join(f'<div class="kpi"><b>{k}</b><span>{v}</span></div>' for k, v in kp) + "</div>"
    h += '<p class="muted">Achats = marchandises reçues ; factures = dépenses engagées ; paiements = argent réellement versé (confirmé par la direction) ; consommation = sorties du magasin valorisées au coût moyen pondéré. Ce ne sont pas des ventes.</p>'
    h += "<h2>Consommation valorisée par service</h2>" + tbl(["Service", "Valeur"], [[E(x["label"]), DA(x["total"])] for x in R["consommation"]] + [["<b>Total</b>", f"<b>{DA(t['consommation'])}</b>"]], (1,))
    h += "<h2>Achats par fournisseur</h2>" + tbl(["Fournisseur", "Bons", "Montant reçu"], [[E(x["supplier"]), x["nb"], DA(x["total"])] for x in R["achats"]], (1, 2))
    h += "<h2>Factures de la période</h2>" + tbl(["Fournisseur", "Factures", "Montant"], [[E(x["supplier"]), x["nb"], DA(x["total"])] for x in R["factures"]], (1, 2))
    h += "<h2>Paiements effectués</h2>" + tbl(["Fournisseur", "Mode", "Nombre", "Montant"], [[E(x["supplier"]), MODES.get(x["mode"], x["mode"]), x["nb"], DA(x["total"])] for x in R["paiements"]], (2, 3))
    h += f"<h2>Dettes fournisseurs au {fr_date(R['end'])}</h2>" + tbl(["Fournisseur", "Reste dû"], [[E(x["supplier"]), DA(x["total"])] for x in R["dettes"]], (1,))
    h += "<h2>Pertes, casse et retours fournisseurs</h2>" + tbl(["Article", "Type", "Quantité", "Valeur"], [[E(x["item"]), "Perte / casse" if x["kind"] == "perte" else "Retour fournisseur", M.fmt_qty(x["qty"], x["unit"]), DA(x["total"])] for x in R["pertes"]], (2, 3))
    h += "<h2>Écarts d'inventaire approuvés</h2>" + tbl(["Article", "Écart", "Valeur"], [[E(x["item"]), M.fmt_qty(x["qty"], x["unit"]), DA(x["total"])] for x in R["ecarts"]], (1, 2))
    h += "<h2>Détail des sorties par article et service</h2>" + tbl(["Article", "Service", "Quantité", "Valeur"], [[E(x["item"]), SERVICES.get(x["service"], ""), M.fmt_qty(x["qty"], x["unit"]), DA(x["total"])] for x in R["consommation_articles"]], (2, 3))
    h += "<h2>Variation du stock</h2>" + tbl(["", "Valeur"], [["Stock au début", DA(R["stock_debut"])], ["+ Entrées (réceptions nettes)", DA(R["entrees_stock"])], ["− Consommation des services", DA(t["consommation"])],
                                                          ["− Pertes et retours fournisseurs", DA(t["pertes"])], ["± Écarts d'inventaire", DA(t["ecarts"])], ["<b>= Stock à la fin</b>", f"<b>{DA(R['stock_fin'])}</b>"]], (1,))
    if R["controle"]: h += f'<p class="warn">Contrôle de cohérence : écart de {DA(R["controle"])} à vérifier.</p>'
    if R["alertes"]: h += "<h2>Articles sous le seuil d'alerte</h2>" + tbl(["Article", "Stock", "Seuil"], [[E(x["name"]), M.fmt_qty(x["qty"], x["unit"]), M.fmt_qty(x["min_qty"], x["unit"])] for x in R["alertes"]], (1, 2))
    lab = {"semaine": "Rapport hebdomadaire", "mois": "Rapport mensuel", "libre": "Rapport de période"}[R["period"]]
    return page(lab, f"Du {fr_date(R['start'])} au {fr_date(R['end'])}", "", [("Période", f"{fr_date(R['start'])} → {fr_date(R['end'])}")], h)


def doc_issue(c, sid):
    s = one(c, "SELECT x.*,u.display_name who,f.name supplier FROM issue_slips x JOIN users u ON u.id=x.created_by LEFT JOIN suppliers f ON f.id=x.supplier_id WHERE x.id=?", (sid,))
    if not s: raise M.Err("Bon introuvable", 404)
    ls = rows(c, "SELECT i.name,i.base_unit,m.qty,m.value FROM stock_movements m JOIN items i ON i.id=m.item_id WHERE ref_type='issue' AND ref_id=? ORDER BY m.id", (sid,))
    body = tbl(["Article", "Quantité", "Coût moyen", "Valeur"], [[E(l["name"]), M.fmt_qty(abs(l["qty"]), l["base_unit"]), DA(int(round(abs(l["value"]) * 1000 / abs(l["qty"])))) + " / " + l["base_unit"], DA(abs(l["value"]))] for l in ls] +
               [["<b>Total</b>", "", "", f"<b>{DA(s['total'])}</b>"]], (1, 2, 3))
    if s["reason"]: body = f"<p><b>Motif :</b> {E(s['reason'])}</p>" + body
    dest = SERVICES.get(s["service"]) or (s["supplier"] or "")
    body += f'<div class="sign"><div><b>Délivré par le magasinier</b>{E(s["who"])}<br><br>Signature :</div><div><b>Reçu par</b>{E(s["requested_by"])}<br><br>Signature :</div></div>'
    return page(M.ISSUE_KINDS[s["kind"]], f"Bon n° S-{sid:05d}", "", [("Date", fr_date(s["created_at"])), ("Destination", E(dest)), ("Demandeur", E(s["requested_by"]) or "—"), ("Valeur", DA(s["total"]))], body)


def doc_receipt(c, rid):
    r = one(c, "SELECT r.*,s.name supplier,u.display_name who FROM receipts r JOIN suppliers s ON s.id=r.supplier_id JOIN users u ON u.id=r.created_by WHERE r.id=?", (rid,))
    if not r: raise M.Err("Bon introuvable", 404)
    ls = rows(c, "SELECT l.*,i.name,i.base_unit FROM receipt_lines l JOIN items i ON i.id=l.item_id WHERE receipt_id=? ORDER BY l.id", (rid,))
    misc = rows(c, "SELECT * FROM receipt_misc_lines WHERE receipt_id=? ORDER BY id", (rid,))
    if misc:
        body = tbl(["Désignation (achat divers, hors stock)", "Montant"], [[E(l["label"]), DA(l["amount"])] for l in misc] + [["<b>Total</b>", f"<b>{DA(r['total'])}</b>"]], (1,))
    else: body = tbl(["Article", "Quantité", "Prix unitaire", "Remise", "Montant"], [[E(l["name"]), f"{M.fmt_qty(int(round(l['qty_entered'] * 1000)), l['unit_name'])}" + (f" <span class=muted>= {M.fmt_qty(l['qty'], l['base_unit'])}</span>" if l["unit_name"] != l["base_unit"] else ""),
                                                                               DA(l["unit_price"]) + " / " + E(l["unit_name"]), f"{l['discount_pct']:g} %" if l["discount_pct"] else "", DA(l["total"])] for l in ls] +
               [["<b>Total</b>", "", "", "", f"<b>{DA(r['total'])}</b>"]], (1, 2, 3, 4))
    if r["status"] == "annulee": body = f'<p class="warn">BON ANNULÉ le {fr_date(r["cancelled_at"])} : {E(r["cancel_reason"])}</p>' + body
    if r["notes"]: body += f"<p><b>Notes :</b> {E(r['notes'])}</p>"
    return page("Bon de réception", f"{r['supplier']} — n° {r['number']}", "Annulé" if r["status"] == "annulee" else "Validé",
                [("Fournisseur", E(r["supplier"])), ("N° du bon", E(r["number"])), ("Date du bon", fr_date(r["doc_date"])), ("Saisi par", E(r["who"]) + " le " + fr_date(r["created_at"]))], body)


def doc_inventory(c, iid):
    inv = M.inventory_detail(c, iid)
    body = tbl(["Article", "Stock théorique", "Compté", "Écart", "Valeur écart", "Raison"],
               [[E(l["name"]), M.fmt_qty(l["expected"], l["base_unit"]), M.fmt_qty(l["counted"], l["base_unit"]), M.fmt_qty(l["delta"], l["base_unit"]) if l["delta"] else "—",
                 DA(l["delta_value"]) if l["delta"] else "—", E(l["reason"])] for l in inv["lines"]], (1, 2, 3, 4))
    tot = sum(l["delta_value"] for l in inv["lines"] if l["delta"])
    body += f"<p><b>Valeur totale des écarts : {DA(tot)}</b></p>"
    if inv["review_comment"]: body += f'<div class="note"><b>Direction :</b> {E(inv["review_comment"])}</div>'
    body += f'<div class="sign"><div><b>Compté par</b>{E(inv["author"])}<br>{fr_date(inv["submitted_at"])}<br><br>Signature :</div><div><b>Validation direction</b>{E(inv.get("reviewer") or "")}<br>{fr_date(inv.get("reviewed_at"))}<br><br>Signature :</div></div>'
    return page("Inventaire physique", f"Inventaire n° I-{iid:04d}", STATUS.get(inv["status"], inv["status"]), [("Créé le", fr_date(inv["created_at"])), ("Articles comptés", str(len(inv["lines"]))), ("Note", E(inv["note"]) or "—")], body)


def doc_stock(c):
    its = rows(c, "SELECT * FROM items WHERE active=1 ORDER BY category,name")
    data = [[E(i["category"]), E(i["name"]), M.fmt_qty(i["qty"], i["base_unit"]), DA(int(round(i["value"] * 1000 / i["qty"]))) + " / " + i["base_unit"] if i["qty"] else "—", DA(i["value"]),
             '<span class="warn">sous le seuil</span>' if i["min_qty"] and i["qty"] <= i["min_qty"] else ""] for i in its]
    data.append(["", "<b>Total</b>", "", "", f"<b>{DA(sum(i['value'] for i in its))}</b>", ""])
    return page("État du stock", "Valorisation au coût moyen pondéré", "", [("Date", datetime.now().strftime("%d/%m/%Y %H:%M")), ("Articles", str(len(its)))],
                tbl(["Catégorie", "Article", "Quantité", "Coût moyen", "Valeur", ""], data, (2, 3, 4)))


# ------------------------------------------------------------------ PDF
def find_browser():
    env = os.environ.get("MB_STOCKS_BROWSER")
    cands = [env] if env else []
    cands += [r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
              r"C:\Program Files\Google\Chrome\Application\chrome.exe", shutil.which("msedge"), shutil.which("google-chrome"),
              shutil.which("chromium"), shutil.which("chromium-browser")]
    return next((x for x in cands if x and Path(x).exists()), None)


def to_pdf(html_text):
    b = find_browser()
    if not b: raise M.Err("Navigateur Edge introuvable sur le serveur : utilisez « Imprimer » puis « Enregistrer en PDF »", 501)
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "doc.html"; out = Path(tmp) / "doc.pdf"
        src.write_text(html_text, encoding="utf-8")
        cmd = [b, "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--disable-extensions", f"--user-data-dir={Path(tmp) / 'profil'}",
               "--no-pdf-header-footer", f"--print-to-pdf={out}", src.as_uri()]
        try: subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=90, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except subprocess.TimeoutExpired: raise M.Err("La création du PDF a pris trop de temps", 504)
        if not out.exists() or out.stat().st_size < 500: raise M.Err("La création du PDF a échoué", 500)
        return out.read_bytes()


# ------------------------------------------------------------------ CSV
def csv_bytes(head, data):
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";", lineterminator="\r\n")
    w.writerow(head)
    for r in data: w.writerow(["" if x is None else x for x in r])
    return ("\ufeff" + buf.getvalue()).encode("utf-8")


def n_da(c): return f"{c / 100:.2f}".replace(".", ",")
def n_q(m): return f"{m / 1000:.3f}".rstrip("0").rstrip(".").replace(".", ",")


def export(c, name, q):
    if name == "stock":
        return csv_bytes(["Catégorie", "Article", "Unité", "Quantité", "Coût moyen (DA)", "Valeur (DA)", "Seuil", "Emplacement"],
                         [[i["category"], i["name"], i["base_unit"], n_q(i["qty"]), n_da(i["value"] * 1000 / i["qty"]) if i["qty"] else "", n_da(i["value"]), n_q(i["min_qty"]), i["location"]]
                          for i in rows(c, "SELECT * FROM items ORDER BY category,name")])
    start = q.get("start") or "2000-01-01"; end = q.get("end") or "2999-12-31"
    if name == "mouvements":
        return csv_bytes(["Date", "Article", "Type", "Service", "Quantité", "Unité", "Valeur (DA)", "Stock après", "Référence", "Par"],
                         [[m["created_at"], m["name"], m["kind"], SERVICES.get(m["service"], ""), n_q(m["qty"]), m["base_unit"], n_da(m["value"]), n_q(m["qty_after"]), f"{m['ref_type']} {m['ref_id']}", m["who"]]
                          for m in rows(c, "SELECT m.*,i.name,i.base_unit,u.display_name who FROM stock_movements m JOIN items i ON i.id=m.item_id JOIN users u ON u.id=m.created_by WHERE m.created_at BETWEEN ? AND ? ORDER BY m.id", (start, end + " 23:59:59"))])
    if name == "factures":
        out = []
        for i in rows(c, "SELECT i.*,s.name supplier FROM invoices i JOIN suppliers s ON s.id=i.supplier_id WHERE i.doc_date BETWEEN ? AND ? ORDER BY i.doc_date", (start, end)):
            out.append([i["doc_date"], i["supplier"], i["number"], i["kind"], i["status"], n_da(i["amount"]), n_da(M.paid(c, i["id"])), n_da(M.due(c, i["id"])), i["due_date"] or ""])
        return csv_bytes(["Date", "Fournisseur", "N°", "Type", "Statut", "Montant (DA)", "Payé (DA)", "Reste dû (DA)", "Échéance"], out)
    if name == "paiements":
        return csv_bytes(["Date", "Fournisseur", "Facture", "Demande", "Mode", "Référence", "Montant (DA)", "Confirmé par", "Annulé"],
                         [[p["paid_on"], p["supplier"], p["inv"], p["req"], MODES.get(p["mode"], p["mode"]), p["reference"], n_da(p["amount"]), p["who"], p["cancel"] or ""]
                          for p in rows(c, """SELECT p.*,s.name supplier,i.number inv,r.number req,u.display_name who,x.reason cancel FROM payments p JOIN invoices i ON i.id=p.invoice_id
                                             JOIN suppliers s ON s.id=i.supplier_id JOIN payment_requests r ON r.id=p.request_id JOIN users u ON u.id=p.confirmed_by
                                             LEFT JOIN payment_cancellations x ON x.payment_id=p.id WHERE p.paid_on BETWEEN ? AND ? ORDER BY p.paid_on""", (start, end))])
    if name == "receptions":
        return csv_bytes(["Date", "Fournisseur", "N° bon", "Statut", "Article", "Quantité saisie", "Unité", "Quantité base", "Prix unitaire (DA)", "Remise %", "Montant (DA)"],
                         [[l["doc_date"], l["supplier"], l["number"], l["status"], l["name"], str(l["qty_entered"]).replace(".", ","), l["unit_name"], n_q(l["qty"]), n_da(l["unit_price"]), l["discount_pct"], n_da(l["total"])]
                          for l in rows(c, """SELECT r.doc_date,r.number,r.status,s.name supplier,l.*,i.name FROM receipt_lines l JOIN receipts r ON r.id=l.receipt_id JOIN suppliers s ON s.id=r.supplier_id
                                             JOIN items i ON i.id=l.item_id WHERE r.doc_date BETWEEN ? AND ? ORDER BY r.doc_date,r.id""", (start, end))] +
                         [[l["doc_date"], l["supplier"], l["number"], l["status"], "Divers : " + l["label"], "", "", "", "", "", n_da(l["amount"])]
                          for l in rows(c, """SELECT r.doc_date,r.number,r.status,s.name supplier,l.label,l.amount FROM receipt_misc_lines l JOIN receipts r ON r.id=l.receipt_id
                                             JOIN suppliers s ON s.id=r.supplier_id WHERE r.doc_date BETWEEN ? AND ? ORDER BY r.doc_date,r.id""", (start, end))])
    if name == "rapport":
        R = M.report(c, q); t = R["totaux"]
        data = [["Période", R["start"], R["end"]], [], ["Indicateur", "Valeur (DA)"]] + [[k, n_da(v)] for k, v in
               [("Achats reçus", t["achats"]), ("Factures enregistrées", t["factures"]), ("Paiements effectués", t["paiements"]), ("Dettes fournisseurs", t["dettes"]),
                ("Consommation services", t["consommation"]), ("Pertes et retours", t["pertes"]), ("Écarts d'inventaire", t["ecarts"]), ("Stock début", R["stock_debut"]), ("Stock fin", R["stock_fin"])]]
        data += [[], ["Consommation par service", "Valeur (DA)"]] + [[x["label"], n_da(x["total"])] for x in R["consommation"]]
        data += [[], ["Achats par fournisseur", "Bons", "Montant (DA)"]] + [[x["supplier"], x["nb"], n_da(x["total"])] for x in R["achats"]]
        data += [[], ["Paiements par fournisseur", "Mode", "Montant (DA)"]] + [[x["supplier"], MODES.get(x["mode"]), n_da(x["total"])] for x in R["paiements"]]
        data += [[], ["Dettes par fournisseur", "Reste dû (DA)"]] + [[x["supplier"], n_da(x["total"])] for x in R["dettes"]]
        data += [[], ["Article", "Service", "Quantité", "Unité", "Valeur (DA)"]] + [[x["item"], SERVICES.get(x["service"]), n_q(x["qty"]), x["unit"], n_da(x["total"])] for x in R["consommation_articles"]]
        return csv_bytes(["Rapport La Maison Blanche — stocks"], data)
    raise M.Err("Export inconnu", 404)
