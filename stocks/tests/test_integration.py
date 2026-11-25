#!/usr/bin/env python3
"""Tests du logiciel de stocks — données de TEST uniquement (base temporaire).
Lancer depuis le dossier stocks :  py -m unittest discover -s tests -v
"""
import base64, csv, io, json, os, shutil, socket, sqlite3, ssl, subprocess, sys, tempfile, threading, time, unittest, urllib.error, urllib.request, uuid
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
PY = sys.executable
MAG_PW, DIR_PW = "Magasin-2026-test", "Direction-2026-test"


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


class Srv:
    def __init__(self, data, port=None, extra=()):
        self.data, self.port, self.extra = data, port or free_port(), list(extra)
        self.scheme = "https" if "--cert" in self.extra else "http"
        self.proc = None

    def start(self):
        env = dict(os.environ, MB_STOCKS_NO_BACKUP="1", MB_STOCKS_NO_CATALOGUE="1")
        self.proc = subprocess.Popen([PY, str(ROOT / "server.py"), "--data", str(self.data), "--port", str(self.port)] + self.extra,
                                     env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        ctx = ssl._create_unverified_context()
        for _ in range(100):
            try:
                urllib.request.urlopen(f"{self.scheme}://127.0.0.1:{self.port}/api/ping", timeout=.5, context=ctx if self.scheme == "https" else None); return self
            except Exception: time.sleep(.1)
        raise RuntimeError("Serveur non démarré : " + self.proc.stderr.read().decode()[-2000:] if self.proc.poll() is not None else "délai")

    def stop(self, kill=False):
        if self.proc:
            (self.proc.kill if kill else self.proc.terminate)(); self.proc.wait(10); self.proc = None


def call(port, path, data=None, token=None, raw=False, method=None):
    h = {"Content-Type": "application/json"}
    if token: h["Authorization"] = "Bearer " + token
    req = urllib.request.Request(f"http://127.0.0.1:{port}/api/{path}", data=json.dumps(data).encode() if data is not None else None, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            b = r.read()
            return (r.status, b, r.headers) if raw else json.loads(b)
    except urllib.error.HTTPError as e:
        b = e.read()
        if raw: return e.code, b, e.headers
        try: return {"status": e.code, **json.loads(b)}
        except ValueError: return {"status": e.code, "erreur": b.decode(errors="replace")}


def U(): return uuid.uuid4().hex


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="mbstocks-test-")
        cls.data = Path(cls.tmp) / "data"
        for name, role, pw in (("magasinier", "magasinier", MAG_PW), ("direction", "direction", DIR_PW)):
            subprocess.run([PY, str(ROOT / "server.py"), "--data", str(cls.data), "creer-compte", name, role, name.title(), "--mot-de-passe-env", "PW"],
                           env=dict(os.environ, PW=pw), check=True, stdout=subprocess.DEVNULL)
        cls.srv = Srv(cls.data).start(); cls.port = cls.srv.port
        cls.mag = cls.login("magasinier", MAG_PW); cls.dir = cls.login("direction", DIR_PW)

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop(); shutil.rmtree(cls.tmp, ignore_errors=True)

    @classmethod
    def login(cls, u, p): return call(cls.port, "connexion", {"username": u, "password": p})["token"]

    def m(self, path, data=None): return call(self.port, path, data, self.mag)
    def d(self, path, data=None): return call(self.port, path, data, self.dir)

    def ok(self, r):
        self.assertNotIn("status", r, r.get("erreur") if isinstance(r, dict) else r); return r

    def supplier(self, name): return self.ok(self.m("fournisseur", {"name": name}))["id"]

    def item(self, name, unit="kg", units=None, min_qty=0):
        return self.ok(self.m("article", {"name": name, "base_unit": unit, "units": units or [], "min_qty": min_qty, "category": "Test"}))["id"]

    def stock(self, iid):
        it = next(i for i in self.m("referentiel")["items"] if i["id"] == iid); return it["qty"], it["value"]

    def receive(self, sup, number, lines, **kw):
        return self.m("reception", {"supplier_id": sup, "number": number, "doc_date": kw.pop("doc_date", date.today().isoformat()), "lines": lines, "client_uid": U(), **kw})


class T1Stocks(Base):
    def test_01_reception_sortie_acceptance(self):
        """Réception 10 kg, sortie 3 kg cuisine => 7 kg ; sortie 8 kg refusée."""
        s = self.supplier("Fournisseur A"); farine = self.item("Farine T55")
        r = self.ok(self.receive(s, "BL-001", [{"item_id": farine, "qty": "10", "unit": "kg", "unit_price": "100"}]))
        self.assertEqual(r["total"], 100000)
        self.assertEqual(self.stock(farine), (10000, 100000))
        self.ok(self.m("mouvement", {"kind": "sortie", "service": "cuisine", "lines": [{"item_id": farine, "qty": 3}], "client_uid": U()}))
        self.assertEqual(self.stock(farine)[0], 7000)
        r = self.m("mouvement", {"kind": "sortie", "service": "cuisine", "lines": [{"item_id": farine, "qty": 8}], "client_uid": U()})
        self.assertEqual(r["status"], 409); self.assertEqual(r["code"], "stock_insuffisant")
        self.assertEqual(self.stock(farine)[0], 7000)

    def test_02_multi_articles_conversions(self):
        s = self.supplier("Fournisseur B")
        lait = self.item("Lait UHT", "L", [{"name": "pack", "factor": 6}])
        oeuf = self.item("Oeufs", "u", [{"name": "plateau", "factor": 30}])
        sucre = self.item("Sucre", "kg")
        r = self.ok(self.receive(s, "BL-77", [
            {"item_id": lait, "qty": 4, "unit": "pack", "unit_price": 900},           # 24 L, 3600 DA
            {"item_id": oeuf, "qty": "2", "unit": "plateau", "unit_price": "750,50"},  # 60 u, 1501 DA
            {"item_id": sucre, "qty": "2500", "unit": "g", "unit_price": "0,12", "discount_pct": 10}]))  # 2,5 kg, 270 DA
        self.assertEqual(r["total"], 360000 + 150100 + 27000)
        self.assertEqual(self.stock(lait)[0], 24000); self.assertEqual(self.stock(oeuf)[0], 60000); self.assertEqual(self.stock(sucre)[0], 2500)
        # sortie en mL et en plateau
        self.ok(self.m("mouvement", {"kind": "sortie", "service": "brunch", "lines": [{"item_id": lait, "qty": 1500, "unit": "mL"}, {"item_id": oeuf, "qty": 1, "unit": "plateau"}], "client_uid": U()}))
        self.assertEqual(self.stock(lait)[0], 22500); self.assertEqual(self.stock(oeuf)[0], 30000)
        bad = self.receive(s, "BL-78", [{"item_id": lait, "qty": 1, "unit": "carton", "unit_price": 1}])
        self.assertEqual(bad["status"], 400)
        bad = self.receive(s, "BL-79", [{"item_id": lait, "qty": "-2", "unit": "L", "unit_price": 1}])
        self.assertEqual(bad["status"], 400)
        bad = self.receive(s, "BL-80", [{"item_id": lait, "qty": "1,2345", "unit": "L", "unit_price": 1}])
        self.assertEqual(bad["status"], 400)
        # unité de base non modifiable après mouvements
        self.assertEqual(self.m("article", {"id": lait, "name": "Lait UHT", "base_unit": "kg"})["status"], 400)

    def test_03_doublons(self):
        s = self.supplier("Fournisseur C"); it = self.item("Riz")
        self.ok(self.receive(s, "BL-0042", [{"item_id": it, "qty": 5, "unit_price": 200}]))
        for num in ("BL-0042", "bl 42", "BL/042"):
            r = self.receive(s, num, [{"item_id": it, "qty": 5, "unit_price": 200}])
            self.assertEqual(r["status"], 409, num); self.assertEqual(r["code"], "doublon")
        r = self.receive(s, "BL-0043", [{"item_id": it, "qty": 5, "unit_price": 200}])
        self.assertEqual(r["code"], "doublon_probable")
        self.ok(self.receive(s, "BL-0043", [{"item_id": it, "qty": 5, "unit_price": 200}], force=True, duplicate_reason="Deuxième livraison le même jour"))
        self.assertEqual(self.stock(it)[0], 10000)
        # idempotence : la même saisie renvoyée deux fois (double clic, coupure réseau) n'est enregistrée qu'une fois
        uid = U(); body = {"supplier_id": s, "number": "BL-0050", "doc_date": date.today().isoformat(), "lines": [{"item_id": it, "qty": 1, "unit_price": 1}], "client_uid": uid}
        a = self.ok(self.m("reception", body)); b = self.ok(self.m("reception", body))
        self.assertEqual(a["id"], b["id"]); self.assertTrue(b.get("deja_enregistre")); self.assertEqual(self.stock(it)[0], 11000)

    def test_04_cump_et_services(self):
        s = self.supplier("Fournisseur D"); it = self.item("Saumon")
        self.ok(self.receive(s, "S1", [{"item_id": it, "qty": 10, "unit_price": 100}]))
        self.ok(self.receive(s, "S2", [{"item_id": it, "qty": 10, "unit_price": 200}]))  # CUMP = 150
        vals = {}
        for svc, q in (("cuisine", 2), ("asiatique", 4), ("brunch", 1), ("comptoir", 3)):
            r = self.ok(self.m("mouvement", {"kind": "sortie", "service": svc, "lines": [{"item_id": it, "qty": q}], "client_uid": U(), "requested_by": "Chef " + svc}))
            vals[svc] = r["total"]
        self.assertEqual(vals, {"cuisine": 30000, "asiatique": 60000, "brunch": 15000, "comptoir": 45000})
        self.assertEqual(self.stock(it), (10000, 150000))
        # retour d'un service au coût moyen, perte, retour fournisseur
        self.ok(self.m("mouvement", {"kind": "retour_service", "service": "asiatique", "lines": [{"item_id": it, "qty": 1}], "client_uid": U()}))
        self.assertEqual(self.m("mouvement", {"kind": "perte", "lines": [{"item_id": it, "qty": 1}], "client_uid": U()})["status"], 400)  # motif obligatoire
        self.ok(self.m("mouvement", {"kind": "perte", "reason": "Rupture chaîne du froid", "lines": [{"item_id": it, "qty": 1}], "client_uid": U()}))
        self.ok(self.m("mouvement", {"kind": "retour_fournisseur", "supplier_id": s, "reason": "Qualité", "lines": [{"item_id": it, "qty": 2}], "client_uid": U()}))
        self.assertEqual(self.stock(it), (8000, 120000))
        # le magasinier seul autorise les sorties
        self.assertEqual(self.d("mouvement", {"kind": "sortie", "service": "cuisine", "lines": [{"item_id": it, "qty": 1}]})["status"], 403)
        # sortie de tout le stock : valeur remise exactement à zéro
        self.ok(self.m("mouvement", {"kind": "sortie", "service": "cuisine", "lines": [{"item_id": it, "qty": 8}], "client_uid": U()}))
        self.assertEqual(self.stock(it), (0, 0))
        rep = self.m("rapport?period=semaine")
        self.assertEqual(rep["controle"], 0)
        asi = next(x for x in rep["consommation"] if x["service"] == "asiatique")
        self.assertGreaterEqual(asi["total"], 60000 - 15000)

    def test_05_inventaire(self):
        s = self.supplier("Fournisseur E"); it = self.item("Huile", "L")
        self.ok(self.receive(s, "H1", [{"item_id": it, "qty": 20, "unit_price": 300}]))
        inv = self.ok(self.m("inventaire", {"lines": [{"item_id": it, "counted": "18,5", "unit": "L"}]}))["id"]
        r = self.m("inventaire", {"id": inv, "submit": True})
        self.assertEqual(r["status"], 400)  # raison obligatoire pour un écart
        self.ok(self.m("inventaire", {"id": inv, "lines": [{"item_id": it, "counted": "18,5", "unit": "L", "reason": "Fuite bidon"}], "submit": True}))
        self.assertEqual(self.m("inventaire/decision", {"inventory_id": inv, "action": "approuver"})["status"], 403)
        self.assertEqual(self.stock(it)[0], 20000)  # pas d'ajustement avant approbation
        self.ok(self.d("inventaire/decision", {"inventory_id": inv, "action": "approuver"}))
        self.assertEqual(self.stock(it), (18500, 555000))
        d = self.m(f"inventaire/{inv}")
        self.assertEqual(d["lines"][0]["applied_value"], -45000)
        self.assertEqual(self.d("inventaire/decision", {"inventory_id": inv, "action": "approuver"})["status"], 409)
        # inventaire rejeté : aucun effet
        inv2 = self.ok(self.m("inventaire", {"lines": [{"item_id": it, "counted": 30, "reason": "?"}], "submit": True}))["id"]
        self.ok(self.d("inventaire/decision", {"inventory_id": inv2, "action": "rejeter", "comment": "Recompter"}))
        self.assertEqual(self.stock(it)[0], 18500)


class T4AchatsDivers(Base):
    def test_01_bon_divers_sans_stock_puis_paiement(self):
        s = self.supplier("Divers test"); it = self.item("Sel fin")
        r = self.ok(self.m("reception", {"supplier_id": s, "number": "D-01", "doc_date": date.today().isoformat(), "client_uid": U(), "divers": True,
                                         "misc_lines": [{"label": "Sacs poubelle", "amount": "1500"}, {"label": "Réparation robinet", "amount": "2000,50"}],
                                         "invoice": {"number": "", "amount": ""}}))
        self.assertEqual(r["total"], 350050); self.assertIn("invoice_id", r)
        b = self.m(f"reception/{r['id']}")
        self.assertEqual(len(b["misc_lines"]), 2); self.assertEqual(b["lines"], []); self.assertEqual(b["divers"], 1)
        self.assertEqual(self.stock(it), (0, 0))
        self.assertEqual(self.m("reception", {"supplier_id": s, "number": "D-02", "doc_date": date.today().isoformat(), "client_uid": U(), "divers": True, "misc_lines": []})["status"], 400)
        self.assertEqual(self.m("reception", {"supplier_id": s, "number": "D-03", "doc_date": date.today().isoformat(), "client_uid": U(), "divers": True, "misc_lines": [{"label": "x", "amount": "0"}]})["status"], 400)
        st, body, _ = call(self.port, f"doc/reception/{r['id']}", token=self.mag, raw=True)
        self.assertEqual(st, 200); self.assertIn("Sacs poubelle", body.decode())


class T2Paiements(Base):
    def invoice(self, sup, num, amount, doc_date=None, **kw):
        return self.ok(self.m("facture", {"supplier_id": sup, "number": num, "amount": amount, "doc_date": doc_date or date.today().isoformat(), "client_uid": U(), **kw}))["id"]

    def test_01_parcours_paiement_complet(self):
        s = self.supplier("Grossiste 1"); inv = self.invoice(s, "F-001", 10000)
        rid = self.ok(self.m("demande", {"lines": [{"invoice_id": inv}], "submit": True, "client_uid": U()}))["id"]
        req = self.m(f"demande/{rid}"); self.assertEqual(req["status"], "soumise"); self.assertEqual(req["total_requested"], 1000000)
        # le magasinier ne peut ni approuver ni payer
        self.assertEqual(self.m("demande/decision", {"request_id": rid, "action": "approuver"})["status"], 403)
        self.assertEqual(self.m("paiement", {"request_id": rid, "invoice_id": inv, "amount": 4000, "mode": "especes"})["status"], 403)
        # la direction ne peut pas payer avant approbation
        self.assertEqual(self.d("paiement", {"request_id": rid, "invoice_id": inv, "amount": 4000, "mode": "especes", "client_uid": U()})["code"], "non_approuvee")
        self.ok(self.d("demande/decision", {"request_id": rid, "action": "approuver"}))
        f = self.m(f"facture/{inv}"); self.assertEqual(f["due"], 1000000)  # approbation ≠ paiement
        r = self.ok(self.d("paiement", {"request_id": rid, "invoice_id": inv, "amount": 4000, "mode": "especes", "client_uid": U()}))
        self.assertEqual(r["reste"], 600000)
        self.assertEqual(self.m(f"facture/{inv}")["due"], 600000)
        self.assertEqual(self.m(f"demande/{rid}")["status"], "partiellement_payee")
        self.assertEqual(self.d("paiement", {"request_id": rid, "invoice_id": inv, "amount": 6001, "mode": "especes", "client_uid": U()})["code"], "depassement")
        self.assertEqual(self.d("paiement", {"request_id": rid, "invoice_id": inv, "amount": 6000, "mode": "cheque", "client_uid": U()})["status"], 400)  # n° de chèque obligatoire
        self.ok(self.d("paiement", {"request_id": rid, "invoice_id": inv, "amount": 6000, "mode": "cheque", "reference": "CHQ 123456", "client_uid": U()}))
        self.assertEqual(self.m(f"facture/{inv}")["due"], 0)
        self.assertEqual(self.m(f"demande/{rid}")["status"], "payee")
        self.assertEqual(self.d("paiement", {"request_id": rid, "invoice_id": inv, "amount": 1, "mode": "especes", "client_uid": U()})["code"], "non_approuvee")
        # double clic sur « confirmer » : un seul paiement
        s2 = self.supplier("Grossiste 1 bis"); inv2 = self.invoice(s2, "X1", 500)
        r2 = self.ok(self.m("demande", {"lines": [{"invoice_id": inv2}], "submit": True, "client_uid": U()}))["id"]
        self.ok(self.d("demande/decision", {"request_id": r2, "action": "approuver"}))
        uid = U(); body = {"request_id": r2, "invoice_id": inv2, "amount": 500, "mode": "especes", "client_uid": uid}
        a = self.ok(self.d("paiement", body)); b = self.ok(self.d("paiement", body))
        self.assertEqual(a["id"], b["id"]); self.assertEqual(self.m(f"facture/{inv2}")["paid"], 50000)

    def test_02_anciens_soldes_et_verrou(self):
        s = self.supplier("Grossiste 2")
        old = self.invoice(s, "F-OLD", 3000, (date.today() - timedelta(days=20)).isoformat())
        new = self.invoice(s, "F-NEW", 2000)
        pay = {x["id"]: x for x in self.m("a-payer")}
        self.assertIn(old, pay); self.assertIn(new, pay)
        rid = self.ok(self.m("demande", {"lines": [{"invoice_id": old}, {"invoice_id": new, "amount": 500}], "client_uid": U()}))["id"]
        req = self.m(f"demande/{rid}")
        flags = {l["invoice_id"]: l["is_old"] for l in req["lines"]}
        self.assertEqual(flags, {old: 1, new: 0}); self.assertEqual(req["total_old"], 300000); self.assertEqual(req["total_requested"], 350000)
        # une facture déjà dans une demande ouverte ne peut pas être demandée deux fois
        r = self.m("demande", {"lines": [{"invoice_id": old}], "client_uid": U()})
        self.assertEqual(r["code"], "deja_demandee")
        self.assertEqual(next(x for x in self.m("a-payer") if x["id"] == old)["locked_by"], req["number"])
        self.ok(self.m("demande/soumettre", {"request_id": rid}))
        self.assertEqual(self.m("demande", {"id": rid, "lines": [{"invoice_id": old}]})["status"], 409)  # verrouillée après soumission
        self.ok(self.d("demande/decision", {"request_id": rid, "action": "approuver", "approved": {str(req["lines"][0]["id"]): 1000}}))  # plafond
        req = self.m(f"demande/{rid}")
        line_old = next(l for l in req["lines"] if l["invoice_id"] == old)
        self.assertEqual(line_old["approved"], 100000)
        self.assertEqual(self.d("paiement", {"request_id": rid, "invoice_id": old, "amount": 1500, "mode": "especes", "client_uid": U()})["code"], "depassement")
        self.ok(self.d("paiement", {"request_id": rid, "invoice_id": old, "amount": 1000, "mode": "especes", "client_uid": U()}))
        self.ok(self.d("paiement", {"request_id": rid, "invoice_id": new, "amount": 500, "mode": "virement", "reference": "VIR-9", "client_uid": U()}))
        self.assertEqual(self.m(f"demande/{rid}")["status"], "payee")
        # semaine suivante : les restes (2000 + 1500) réapparaissent sans être recréés
        pay = {x["id"]: x for x in self.m("a-payer")}
        self.assertEqual(pay[old]["due"], 200000); self.assertEqual(pay[new]["due"], 150000); self.assertIsNone(pay[old]["locked_by"])
        nb_factures = len(self.m("factures?supplier=%d" % s)); self.assertEqual(nb_factures, 2)

    def test_03_refus_et_correction(self):
        s = self.supplier("Grossiste 3"); inv = self.invoice(s, "F-30", 1000)
        rid = self.ok(self.m("demande", {"lines": [{"invoice_id": inv}], "submit": True, "client_uid": U()}))["id"]
        self.assertEqual(self.d("demande/decision", {"request_id": rid, "action": "corriger"})["status"], 400)  # commentaire obligatoire
        self.ok(self.d("demande/decision", {"request_id": rid, "action": "corriger", "comment": "Montant à revoir"}))
        self.assertEqual(self.d("paiement", {"request_id": rid, "invoice_id": inv, "amount": 100, "mode": "especes", "client_uid": U()})["code"], "non_approuvee")
        self.ok(self.m("demande", {"id": rid, "lines": [{"invoice_id": inv, "amount": 800}], "submit": True}))
        req = self.m(f"demande/{rid}"); self.assertEqual(req["revision"], 2); self.assertEqual(req["status"], "soumise")
        self.ok(self.d("demande/decision", {"request_id": rid, "action": "refuser", "comment": "Non prioritaire"}))
        self.assertEqual(self.d("paiement", {"request_id": rid, "invoice_id": inv, "amount": 100, "mode": "especes", "client_uid": U()})["code"], "non_approuvee")
        self.assertEqual(self.m(f"demande/{rid}")["status"], "refusee")
        self.assertIsNone(next(x for x in self.m("a-payer") if x["id"] == inv)["locked_by"])  # libérée
        self.assertEqual([h["event"] for h in req["history"]], ["soumise", "a_corriger", "soumise"])

    def test_04_annulation_paiement_avoir_rapprochement(self):
        s = self.supplier("Grossiste 4"); it = self.item("Tomates")
        rec = self.ok(self.receive(s, "BL-T1", [{"item_id": it, "qty": 10, "unit_price": 150}]))
        inv = self.invoice(s, "FT-1", 1600, receipt_ids=[rec["id"]])
        f = self.m(f"facture/{inv}"); self.assertEqual(f["ecart"], 10000)  # facture 1600 vs bon 1500
        self.assertEqual(self.m("facture", {"supplier_id": s, "number": "FT-2", "amount": 1500, "doc_date": date.today().isoformat(), "receipt_ids": [rec["id"]], "client_uid": U(),
                                            "force": True, "duplicate_reason": "test"})["status"], 409)  # bon déjà rapproché
        self.ok(self.m("avoir", {"invoice_id": inv, "number": "AV-1", "amount": 100, "doc_date": date.today().isoformat(), "reason": "Tomates abîmées", "client_uid": U()}))
        self.assertEqual(self.m(f"facture/{inv}")["due"], 150000)
        rid = self.ok(self.m("demande", {"lines": [{"invoice_id": inv}], "submit": True, "client_uid": U()}))["id"]
        self.ok(self.d("demande/decision", {"request_id": rid, "action": "approuver"}))
        p = self.ok(self.d("paiement", {"request_id": rid, "invoice_id": inv, "amount": 1500, "mode": "especes", "client_uid": U()}))["id"]
        self.assertEqual(self.m(f"demande/{rid}")["status"], "payee")
        self.assertEqual(self.m("paiement/annuler", {"payment_id": p, "reason": "x"})["status"], 403)
        self.ok(self.d("paiement/annuler", {"payment_id": p, "reason": "Erreur de saisie"}))
        self.assertEqual(self.m(f"facture/{inv}")["due"], 150000)
        self.assertEqual(self.m(f"demande/{rid}")["status"], "approuvee")
        # bon rapproché : annulation refusée tant que la facture est active
        self.assertEqual(self.d("reception/annuler", {"receipt_id": rec["id"], "reason": "x"})["status"], 409)


class T3Systeme(Base):
    def test_01_droits_et_securite(self):
        self.assertEqual(call(self.port, "tableau")["status"], 401)
        self.assertEqual(call(self.port, "tableau", token="faux")["status"], 401)
        self.assertEqual(self.m("journal")["status"], 403)
        self.assertEqual(self.m("compte", {"action": "creer", "username": "x", "role": "direction", "password": "Abcdef12345"})["status"], 403)
        self.assertEqual(self.m("reception/annuler", {"receipt_id": 1, "reason": "x"})["status"], 403)
        self.assertEqual(self.m("facture/annuler", {"invoice_id": 1, "reason": "x"})["status"], 403)
        # Origine étrangère refusée (protection CSRF)
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/api/fournisseur", data=b'{"name":"x"}', headers={"Content-Type": "application/json", "Authorization": "Bearer " + self.mag, "Origin": "http://pirate.example"})
        with self.assertRaises(urllib.error.HTTPError) as e: urllib.request.urlopen(req)
        self.assertEqual(e.exception.code, 403)
        # anti force brute
        for _ in range(6): call(self.port, "connexion", {"username": "direction", "password": "mauvais"})
        self.assertEqual(call(self.port, "connexion", {"username": "direction", "password": DIR_PW})["status"], 429)
        # fichiers hors du dossier public
        st, _, _ = call(self.port, "../server.py", raw=True)
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/../server.py")
        try: code = urllib.request.urlopen(req).status
        except urllib.error.HTTPError as e2: code = e2.code
        self.assertEqual(code, 404)

    def test_02_compte_provisoire(self):
        r = self.ok(self.d("compte", {"action": "creer", "username": "mag2", "display_name": "Second", "role": "magasinier", "password": "Provisoire-2026"}))
        t = self.login("mag2", "Provisoire-2026")
        self.assertEqual(call(self.port, "fournisseur", {"name": "Z"}, t)["code"], "must_change")
        self.ok(call(self.port, "mot-de-passe", {"old": "Provisoire-2026", "new": "Nouveau-mdp-99"}, t))
        self.assertEqual(self.login("mag2", "Nouveau-mdp-99")[:0], "")
        # blocage après 5 essais ratés, levé par un nouveau mot de passe donné par la direction
        for _ in range(5): call(self.port, "connexion", {"username": "mag2", "password": "mauvais"})
        bloque = call(self.port, "connexion", {"username": "mag2", "password": "Nouveau-mdp-99"})
        self.assertEqual(bloque["status"], 429)
        self.ok(self.d("compte", {"action": "mot_de_passe", "user_id": r["id"], "password": "Provisoire-2027"}))
        self.assertTrue(self.login("mag2", "Provisoire-2027"))
        self.ok(self.d("compte", {"action": "desactiver", "user_id": r["id"]}))
        self.assertEqual(call(self.port, "connexion", {"username": "mag2", "password": "Nouveau-mdp-99"})["status"], 401)

    def test_03_journal_immuable(self):
        s = self.supplier("Journal test"); it = self.item("Journal article")
        self.ok(self.receive(s, "JT1", [{"item_id": it, "qty": 1, "unit_price": 1}]))
        j = self.d("journal"); self.assertTrue(j["integre"]); self.assertGreater(len(j["entries"]), 0)
        c = sqlite3.connect(self.data / "stocks.sqlite3", isolation_level=None)
        try:
            for sql in ("UPDATE audit_log SET action='x'", "DELETE FROM audit_log", "UPDATE stock_movements SET qty=1", "DELETE FROM stock_movements", "UPDATE receipt_lines SET qty=1"):
                with self.assertRaises(sqlite3.DatabaseError, msg=sql): c.execute(sql)
        finally: c.close()

    def test_04_justificatifs(self):
        s = self.supplier("Justif"); it = self.item("Justif article")
        rid = self.ok(self.receive(s, "J1", [{"item_id": it, "qty": 1, "unit_price": 10}]))["id"]
        jpg = b"\xff\xd8\xff\xe0" + b"0" * 2000
        aid = self.ok(self.m("justificatif", {"owner_type": "reception", "owner_id": rid, "filename": "bon.jpg", "data": base64.b64encode(jpg).decode()}))["id"]
        st, body, hd = call(self.port, f"justificatif/{aid}", token=self.mag, raw=True)
        self.assertEqual((st, body, hd["Content-Type"]), (200, jpg, "image/jpeg"))
        self.assertEqual(self.m("justificatif", {"owner_type": "reception", "owner_id": rid, "filename": "x.exe", "data": base64.b64encode(b"MZ\x90\x00").decode()})["status"], 400)
        self.assertEqual(self.m("justificatif", {"owner_type": "paiement", "owner_id": 1, "data": base64.b64encode(jpg).decode()})["status"], 403)
        self.assertEqual(len(self.m(f"reception/{rid}")["attachments"]), 1)

    def test_05_concurrence_deux_postes(self):
        """Deux postes sortent le même article en même temps : jamais de stock négatif ni de double sortie."""
        s = self.supplier("Concurrence"); it = self.item("Beurre")
        self.ok(self.receive(s, "C1", [{"item_id": it, "qty": 10, "unit_price": 1000}]))
        mag_b = self.login("magasinier", MAG_PW)
        results = []
        def worker(tok):
            for _ in range(10):
                results.append(call(self.port, "mouvement", {"kind": "sortie", "service": "cuisine", "lines": [{"item_id": it, "qty": "0.7"}], "client_uid": U()}, tok))
        ts = [threading.Thread(target=worker, args=(t,)) for t in (self.mag, mag_b, self.mag, mag_b)]
        [t.start() for t in ts]; [t.join() for t in ts]
        okc = sum(1 for r in results if "status" not in r); ko = sum(1 for r in results if r.get("status") == 409)
        self.assertEqual(okc + ko, 40); self.assertEqual(okc, 14)  # 14 × 0,7 = 9,8 kg
        q, v = self.stock(it); self.assertEqual(q, 200); self.assertEqual(v, 20000)
        self.assertEqual(self.m("rapport?period=semaine")["controle"], 0)

    def test_06_rapports_csv_pdf(self):
        s = self.supplier("Rapport"); it = self.item("Rapport article")
        self.ok(self.receive(s, "R1", [{"item_id": it, "qty": 4, "unit_price": 250}]))
        self.ok(self.m("mouvement", {"kind": "sortie", "service": "comptoir", "lines": [{"item_id": it, "qty": 1}], "client_uid": U()}))
        inv = self.ok(self.m("facture", {"supplier_id": s, "number": "FR1", "amount": 1000, "doc_date": date.today().isoformat(), "client_uid": U()}))["id"]
        rid = self.ok(self.m("demande", {"lines": [{"invoice_id": inv}], "submit": True, "client_uid": U()}))["id"]
        self.ok(self.d("demande/decision", {"request_id": rid, "action": "approuver"}))
        self.ok(self.d("paiement", {"request_id": rid, "invoice_id": inv, "amount": 400, "mode": "especes", "client_uid": U()}))
        rep = self.m("rapport?period=semaine")
        self.assertEqual(rep["controle"], 0)
        self.assertEqual(next(x for x in rep["achats"] if x["supplier"] == "Rapport")["total"], 100000)
        self.assertEqual(next(x for x in rep["dettes"] if x["supplier"] == "Rapport")["total"], 60000)
        self.assertEqual(next(x for x in rep["paiements"] if x["supplier"] == "Rapport")["total"], 40000)
        # rapprochement à la base
        c = sqlite3.connect(self.data / "stocks.sqlite3")
        self.assertEqual(rep["stock_fin"], c.execute("SELECT SUM(value) FROM items").fetchone()[0])
        c.close()
        self.assertEqual(self.m("rapport?period=mois")["controle"], 0)
        for name in ("stock", "mouvements", "factures", "paiements", "receptions", "rapport"):
            st, body, hd = call(self.port, f"export/{name}.csv", token=self.dir, raw=True)
            self.assertEqual(st, 200, name); self.assertTrue(body.startswith(b"\xef\xbb\xbf"))
            list(csv.reader(io.StringIO(body.decode("utf-8-sig")), delimiter=";"))
        for doc in (f"demande/{rid}", "rapport?period=semaine", "stock"):
            st, body, _ = call(self.port, "doc/" + doc, token=self.mag, raw=True)
            self.assertEqual(st, 200); self.assertIn(b"La Maison Blanche", body)
        import documents
        if documents.find_browser():
            st, body, hd = call(self.port, f"pdf/demande/{rid}", token=self.mag, raw=True)
            self.assertEqual(st, 200); self.assertTrue(body.startswith(b"%PDF")); self.assertGreater(len(body), 5000)
            (ROOT / "tests" / "sortie").mkdir(exist_ok=True)
            (ROOT / "tests" / "sortie" / "demande-exemple.pdf").write_bytes(body)
            st, body, _ = call(self.port, "pdf/rapport?period=semaine", token=self.dir, raw=True)
            self.assertTrue(body.startswith(b"%PDF")); (ROOT / "tests" / "sortie" / "rapport-exemple.pdf").write_bytes(body)


class T4Pannes(Base):
    def test_01_redemarrage_et_coupure(self):
        s = self.supplier("Panne"); it = self.item("Panne article")
        self.ok(self.receive(s, "P1", [{"item_id": it, "qty": 5, "unit_price": 100}]))
        # coupure brutale du serveur (comme une coupure de courant) puis redémarrage
        self.srv.stop(kill=True)
        with self.assertRaises(Exception): urllib.request.urlopen(f"http://127.0.0.1:{self.port}/api/ping", timeout=1)
        self.srv.start()
        # la session survit au redémarrage, les données sont intactes
        self.assertEqual(self.stock(it), (5000, 50000))
        # coupure réseau pendant l'envoi : le poste renvoie la même saisie → pas de doublon
        uid = U(); body = {"kind": "sortie", "service": "cuisine", "lines": [{"item_id": it, "qty": 1}], "client_uid": uid}
        self.ok(self.m("mouvement", body)); self.ok(self.m("mouvement", body))
        self.assertEqual(self.stock(it)[0], 4000)
        c = sqlite3.connect(self.data / "stocks.sqlite3")
        self.assertEqual(c.execute("PRAGMA integrity_check").fetchone()[0], "ok"); c.close()

    def test_02_sauvegarde_restauration(self):
        import backup as B, stockdb as D
        s = self.supplier("Sauvegarde"); it = self.item("Sauvegarde article")
        self.ok(self.receive(s, "B1", [{"item_id": it, "qty": 3, "unit_price": 333}]))
        rid = self.ok(self.m("reception", {"supplier_id": s, "number": "B2", "doc_date": date.today().isoformat(), "lines": [{"item_id": it, "qty": 1, "unit_price": 1}], "client_uid": U()}))["id"]
        self.ok(self.m("justificatif", {"owner_type": "reception", "owner_id": rid, "filename": "b.png", "data": base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"1" * 500).decode()}))
        ext = Path(self.tmp) / "cle-usb"
        out = subprocess.run([PY, str(ROOT / "backup.py"), "--data", str(self.data), "sauvegarder", "--dest", str(self.data / "sauvegardes"), "--dest", str(ext)], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        z = sorted(ext.glob("*.zip"))[-1]
        before = self.m("referentiel"); before_rep = self.d("rapport?period=semaine")
        self.ok(self.m("mouvement", {"kind": "sortie", "service": "cuisine", "lines": [{"item_id": it, "qty": 2}], "client_uid": U()}))
        self.srv.stop()
        out = subprocess.run([PY, str(ROOT / "backup.py"), "--data", str(self.data), "restaurer", str(z), "--oui"], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.srv.start()
        after = self.m("referentiel")
        self.assertEqual([(i["id"], i["qty"], i["value"]) for i in before["items"]], [(i["id"], i["qty"], i["value"]) for i in after["items"]])
        a = self.d("rapport?period=semaine")
        for k in ("achats", "paiements", "dettes", "stock_fin"): self.assertEqual(before_rep[k], a[k], k)
        self.assertEqual(len(self.m(f"reception/{rid}")["attachments"]), 1)
        st, body, _ = call(self.port, f"justificatif/{self.m(f'reception/{rid}')['attachments'][0]['id']}", token=self.mag, raw=True)
        self.assertEqual(st, 200)
        # une sauvegarde altérée est détectée
        bad = Path(self.tmp) / "abimee.zip"; data = bytearray(z.read_bytes()); data[len(data) // 2] ^= 0xFF; bad.write_bytes(bytes(data))
        out = subprocess.run([PY, str(ROOT / "backup.py"), "verifier", str(bad)], capture_output=True, text=True)
        self.assertNotEqual(out.returncode, 0)


class T5Reseau(unittest.TestCase):
    def test_tls_obligatoire(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            r = subprocess.run([PY, str(ROOT / "server.py"), "--data", str(tmp), "--host", "0.0.0.0", "--port", str(free_port())], capture_output=True, text=True, timeout=20)
            self.assertNotEqual(r.returncode, 0); self.assertIn("TLS", r.stderr)
            try: import cryptography  # noqa
            except ImportError: self.skipTest("module cryptography absent")
            subprocess.run([PY, str(ROOT / "outils" / "creer_certificats.py"), "--data", str(tmp), "--nom", "srv-mb", "--ip", "127.0.0.1"], check=True, capture_output=True)
            srv = Srv(tmp, extra=["--host", "127.0.0.1", "--cert", str(tmp / "tls" / "serveur.crt"), "--key", str(tmp / "tls" / "serveur.key")]).start()
            try:
                ctx = ssl.create_default_context(cafile=str(tmp / "tls" / "autorite-mb.crt"))
                with urllib.request.urlopen(f"https://127.0.0.1:{srv.port}/api/ping", context=ctx, timeout=5) as r: self.assertEqual(r.status, 200)
                with self.assertRaises(Exception): urllib.request.urlopen(f"http://127.0.0.1:{srv.port}/api/ping", timeout=3)
                with self.assertRaises(Exception): urllib.request.urlopen(f"https://127.0.0.1:{srv.port}/api/ping", context=ssl.create_default_context(), timeout=3)
            finally: srv.stop()
        finally: shutil.rmtree(tmp, ignore_errors=True)

    def test_reseaux_autorises(self):
        import ipaddress, server
        server.NETWORKS[:] = [ipaddress.ip_network("192.168.1.0/24"), ipaddress.ip_network("127.0.0.0/8")]
        class F: client_address = ("192.168.1.20", 1)
        class G: client_address = ("10.0.0.5", 1)
        self.assertTrue(server.Handler.allowed(F)); self.assertFalse(server.Handler.allowed(G))


if __name__ == "__main__":
    unittest.main(verbosity=2)
