#!/usr/bin/env python3
"""Parcours complet dans le navigateur (magasinier puis direction) avec captures d'écran.
Nécessite : pip install playwright ; un Chrome/Edge installé.
  python tests/ui_parcours.py [--chrome CHEMIN] [--sortie DOSSIER]
"""
import argparse, os, subprocess, sys, tempfile, time, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_integration import Srv, call, U, PY, ROOT, MAG_PW, DIR_PW
from playwright.sync_api import sync_playwright, expect

ap = argparse.ArgumentParser(); ap.add_argument("--chrome", default="/usr/bin/google-chrome"); ap.add_argument("--sortie", default=str(ROOT / "tests" / "sortie"))
args = ap.parse_args()
OUT = Path(args.sortie); OUT.mkdir(parents=True, exist_ok=True)
data = Path(tempfile.mkdtemp()) / "data"
for n, r, p in (("magasinier", "magasinier", MAG_PW), ("direction", "direction", DIR_PW)):
    subprocess.run([PY, str(ROOT / "server.py"), "--data", str(data), "creer-compte", n, r, {"magasinier": "Karim (magasin)", "direction": "Direction"}[n], "--mot-de-passe-env", "PW"], env=dict(os.environ, PW=p), check=True, stdout=subprocess.DEVNULL)
srv = Srv(data).start(); port = srv.port; base = f"http://127.0.0.1:{port}"
tok = call(port, "connexion", {"username": "magasinier", "password": MAG_PW})["token"]
def m(path, d=None): r = call(port, path, d, tok); assert "status" not in r, r; return r
# Référentiel de TEST (données fictives)
sup = {n: m("fournisseur", {"name": n})["id"] for n in ("Boucherie Test", "Marée Test", "Épicerie Test")}
items = {}
for n, cat, u, units, mn in (("Filet de bœuf", "Viandes", "kg", [], 5), ("Saumon frais", "Poissons", "kg", [], 3), ("Riz à sushi", "Épicerie", "kg", [{"name": "sac", "factor": 10}], 10),
                             ("Lait entier", "Crèmerie", "L", [{"name": "pack", "factor": 6}], 12), ("Œufs", "Crèmerie", "u", [{"name": "plateau", "factor": 30}], 60), ("Huile d'olive", "Épicerie", "L", [{"name": "bidon", "factor": 5}], 0)):
    items[n] = m("article", {"name": n, "category": cat, "base_unit": u, "units": units, "min_qty": mn})["id"]
m("reception", {"supplier_id": sup["Marée Test"], "number": "M-1001", "doc_date": time.strftime("%Y-%m-%d"), "client_uid": U(), "lines": [{"item_id": items["Saumon frais"], "qty": 8, "unit_price": 3200}]})
m("facture", {"supplier_id": sup["Épicerie Test"], "kind": "solde_initial", "number": "", "doc_date": "2026-11-01", "amount": 45000, "client_uid": U()})

errors = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=args.chrome, args=["--no-sandbox"])
    pg = b.new_page(viewport={"width": 1440, "height": 900}, locale="fr-FR")
    pg.on("console", lambda msg: msg.type == "error" and errors.append(msg.text))
    pg.on("pageerror", lambda e: errors.append(str(e)))
    shot = lambda n: pg.screenshot(path=str(OUT / f"{n}.png"))
    pg.goto(base); pg.wait_for_selector("#loginForm"); shot("01-connexion")
    pg.fill("#lgUser", "magasinier"); pg.fill("#lgPass", MAG_PW); pg.click("#loginForm button")
    pg.wait_for_selector(".qa"); time.sleep(.4); shot("02-tableau-magasinier")
    # Réception multi-articles via l'interface
    pg.click("text=Nouvelle réception"); pg.wait_for_selector("#rSup")
    pg.select_option("#rSup", str(sup["Boucherie Test"])); pg.fill("#rNum", "BL-2026-0153")
    inp = pg.locator("#rLines [data-k=item]").nth(0); inp.fill("Filet de bœuf"); inp.dispatch_event("change")
    pg.locator("#rLines [data-k=qty]").nth(0).fill("12,5"); pg.locator("#rLines [data-k=unit_price]").nth(0).fill("2800")
    pg.click("#rLines [data-add]")
    inp = pg.locator("#rLines [data-k=item]").nth(1); inp.fill("Riz à sushi"); inp.dispatch_event("change")
    pg.locator("#rLines [data-k=qty]").nth(1).fill("2"); pg.locator("#rLines [data-k=unit_price]").nth(1).fill("4500"); pg.locator("#rLines [data-k=discount_pct]").nth(1).fill("5")
    pg.click("#rLines [data-add]")
    inp = pg.locator("#rLines [data-k=item]").nth(2); inp.fill("Lait entier"); inp.dispatch_event("change")
    pg.locator("#rLines [data-k=qty]").nth(2).fill("4"); pg.locator("#rLines [data-k=unit_price]").nth(2).fill("780")
    pg.check("#rInv"); pg.fill("#riNum", "FA-88")
    time.sleep(.3); shot("03-nouvelle-reception")
    pg.click(".modal [data-a=ok]"); pg.wait_for_selector("text=Justificatifs"); time.sleep(.4); shot("04-bon-valide")
    # justificatif photo
    jpg = OUT / "_photo.jpg"
    from PIL import Image; Image.new("RGB", (1200, 1600), (240, 236, 228)).save(jpg)
    pg.locator(".modal input[type=file]").set_input_files(str(jpg)); time.sleep(1.2)
    pg.keyboard.press("Escape"); pg.keyboard.press("Escape")
    # Doublon
    pg.click("text=Nouvelle réception") if pg.locator("text=Nouvelle réception").count() else pg.click("#newRec")
    pg.wait_for_selector("#rSup"); pg.select_option("#rSup", str(sup["Boucherie Test"])); pg.fill("#rNum", "bl 2026-0153")
    inp = pg.locator("#rLines [data-k=item]").nth(0); inp.fill("Filet de bœuf"); inp.dispatch_event("change")
    pg.locator("#rLines [data-k=qty]").nth(0).fill("1"); pg.locator("#rLines [data-k=unit_price]").nth(0).fill("1")
    pg.click(".modal [data-a=ok]"); pg.wait_for_selector(".modal .err:has-text('Doublon')"); shot("05-doublon-refuse"); pg.keyboard.press("Escape")
    # Sortie vers l'asiatique, puis sortie excessive refusée
    pg.click("#nav [data-p=sorties]"); pg.click("#newIss"); pg.wait_for_selector("#iSvc")
    pg.select_option("#iSvc", "asiatique"); pg.fill("#iReq", "Chef sushi")
    inp = pg.locator("#iLines [data-k=item]").nth(0); inp.fill("Saumon frais"); inp.dispatch_event("change"); pg.locator("#iLines [data-k=qty]").nth(0).fill("2,4")
    pg.click("#iLines [data-add]"); inp = pg.locator("#iLines [data-k=item]").nth(1); inp.fill("Riz à sushi"); inp.dispatch_event("change")
    pg.locator("#iLines [data-k=unit]").nth(1).select_option("kg"); pg.locator("#iLines [data-k=qty]").nth(1).fill("3")
    time.sleep(.2); shot("06-nouvelle-sortie")
    pg.click(".modal [data-a=ok]"); pg.wait_for_selector("iframe.docframe"); time.sleep(1); shot("07-bon-de-sortie"); pg.keyboard.press("Escape")
    pg.click("#newIss"); pg.select_option("#iSvc", "cuisine")
    inp = pg.locator("#iLines [data-k=item]").nth(0); inp.fill("Saumon frais"); inp.dispatch_event("change"); pg.locator("#iLines [data-k=qty]").nth(0).fill("50")
    pg.click(".modal [data-a=ok]"); pg.wait_for_selector(".modal .err:has-text('Stock insuffisant')"); shot("08-sortie-refusee"); pg.keyboard.press("Escape")
    for svc, it, q in (("cuisine", "Filet de bœuf", "4"), ("brunch", "Lait entier", "6"), ("comptoir", "Lait entier", "3")):
        m("mouvement", {"kind": "sortie", "service": svc, "lines": [{"item_id": items[it], "qty": q}], "client_uid": U()})
    pg.click("#nav [data-p=stock]"); pg.wait_for_selector("#stList table"); time.sleep(.3); shot("09-stock")
    # Facture séparée rapprochée du bon de la marée
    pg.click("#nav [data-p=factures]"); pg.click("#fNew"); pg.select_option("#ivS", str(sup["Marée Test"])); pg.fill("#ivN", "MT-552"); pg.fill("#ivA", "25600"); pg.wait_for_selector("#ivB [data-r]")
    pg.check("#ivB [data-r]"); time.sleep(.2); shot("10-facture-rapprochement"); pg.click(".modal [data-a=ok]"); pg.wait_for_selector("text=Bons rapprochés"); pg.keyboard.press("Escape")
    pg.wait_for_selector("#invList table"); shot("11-factures")
    # Demande de paiement hebdomadaire
    pg.click("#nav [data-p=demandes]"); pg.click("#dNew"); pg.wait_for_selector("#qTable"); pg.click("#qAll")
    first = pg.locator("#qTable [data-a]").first; first.fill("20000"); time.sleep(.2); shot("12-preparation-demande")
    pg.click(".modal [data-a=submit]"); pg.wait_for_selector(".steps"); time.sleep(.3); shot("13-demande-soumise")
    pg.click(".modal [data-a=doc]"); pg.wait_for_selector("iframe.docframe"); time.sleep(1.2); shot("14-demande-apercu-pdf")
    pg.keyboard.press("Escape"); pg.keyboard.press("Escape")
    # Inventaire
    pg.click("#nav [data-p=inventaires]"); pg.click("#iNew"); pg.wait_for_selector("#vT [data-c]")
    sid = items["Saumon frais"]
    pg.locator(f'#vT [data-c="{sid}"]').fill("5,4"); pg.locator(f'#vT [data-c="{sid}"]').press("Tab"); time.sleep(.3)
    pg.fill(f'#vT [data-r="{sid}"]', "Parures jetées non déclarées"); time.sleep(.2); shot("15-inventaire")
    pg.click(".modal [data-a=submit]"); time.sleep(.6)
    pg.click("#me #meOut"); pg.wait_for_selector("#loginForm")
    # Direction
    pg.fill("#lgUser", "direction"); pg.fill("#lgPass", DIR_PW); pg.click("#loginForm button"); pg.wait_for_selector(".kpi"); time.sleep(.5); shot("16-tableau-direction")
    pg.click("#nav [data-p=demandes]"); pg.click("tr[data-id]"); pg.wait_for_selector("[data-a=approve]"); shot("17-demande-a-valider")
    pg.click("[data-a=approve]"); pg.click("#modals .back:last-child [data-a=ok]"); pg.wait_for_selector("[data-pay]"); time.sleep(.3); shot("18-demande-approuvee")
    pg.locator("[data-pay]").first.click(); pg.wait_for_selector("#pA"); pg.fill("#pA", "10000"); pg.select_option("#pM", "cheque"); pg.fill("#pR", "CHQ 0045871"); shot("19-confirmer-paiement")
    pg.click("#modals .back:last-child [data-a=ok]"); pg.wait_for_selector(".kpi.good"); time.sleep(.4); shot("20-paiement-partiel")
    pg.keyboard.press("Escape")
    pg.click("#nav [data-p=inventaires]"); pg.click("tr[data-id]"); pg.wait_for_selector("[data-a=app]"); shot("21-inventaire-a-valider")
    pg.click("[data-a=app]"); pg.click("#modals .back:last-child [data-a=ok]"); time.sleep(.6)
    pg.click("#nav [data-p=rapports]"); pg.wait_for_selector("#rBody .kpi"); time.sleep(.4); shot("22-rapport-hebdo")
    pg.click("#rDoc"); pg.wait_for_selector("iframe.docframe"); time.sleep(1.2); shot("23-rapport-apercu"); pg.keyboard.press("Escape")
    pg.click("#nav [data-p=journal]"); pg.wait_for_selector(".alertbox"); shot("24-journal")
    pg.click("#nav [data-p=sauvegardes]"); pg.click("#bNow"); time.sleep(2.5); shot("25-sauvegardes")
    # Coupure réseau : le bandeau s'affiche
    srv.stop(); time.sleep(11); pg.click("#nav [data-p=stock]"); time.sleep(4); shot("26-coupure-reseau")
    srv.start(); time.sleep(11); shot("27-reconnexion")
    pg.click("#nav [data-p=stock]"); pg.wait_for_selector("#stList table")
    b.close()
srv.stop()
print(json.dumps({"erreurs_console": errors}, ensure_ascii=False))
jpg.unlink(missing_ok=True)
sys.exit(1 if [e for e in errors if "Failed to load resource" not in e] else 0)
