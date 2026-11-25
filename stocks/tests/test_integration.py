#!/usr/bin/env python3
"""Tests d'intégration HTTP — exécuter : python -m unittest discover -s stocks/tests -v"""
import importlib.util, json, os, subprocess, sys, tempfile, time, unittest, urllib.error, urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
class StocksIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory()
        cls.db=Path(cls.tmp.name)/"stocks.sqlite3"
        cls.port=18765
        env=os.environ.copy();env["MB_STOCKS_DB"]=str(cls.db)
        spec=importlib.util.spec_from_file_location("mbstocks",ROOT/"server.py")
        mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
        mod.DB=cls.db;mod.init()
        mod.seed_user("magasinier","magasinier","TestMagasinier2026!")
        mod.seed_user("direction","direction","TestDirection2026!")
        cls.proc=subprocess.Popen([sys.executable,str(ROOT/"server.py"),"--port",str(cls.port)],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        for _ in range(40):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{cls.port}/",timeout=.3)
                break
            except Exception:time.sleep(.1)
        else:raise RuntimeError("Serveur non démarré")
        cls.mag=cls.request("login",{"username":"magasinier","password":"TestMagasinier2026!"})["token"]
        cls.dir=cls.request("login",{"username":"direction","password":"TestDirection2026!"})["token"]
    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate();cls.proc.wait(timeout=5);cls.tmp.cleanup()
    @classmethod
    def request(cls,path,data=None,token=None):
        headers={"Content-Type":"application/json"}
        if token:headers["Authorization"]="Bearer "+token
        req=urllib.request.Request(f"http://127.0.0.1:{cls.port}/api/{path}",data=json.dumps(data).encode() if data is not None else None,headers=headers)
        try:
            with urllib.request.urlopen(req,timeout=5) as r:return json.load(r)
        except urllib.error.HTTPError as e:return {"status":e.code,**json.load(e)}
    def test_01_auth_and_permissions(self):
        self.assertEqual(self.request("state")["status"],401)
        self.assertEqual(self.request("login",{"username":"direction","password":"bad"})["status"],401)
        self.assertEqual(self.request("request/review",{"request_id":1,"status":"approuvee"},self.mag)["status"],403)
        self.assertEqual(self.request("payment",{"invoice_id":1,"amount":1,"mode":"Espèces"},self.mag)["status"],403)
    def test_02_full_flow(self):
        self.assertTrue(self.request("supplier",{"name":"Fournisseur test"},self.mag)["ok"])
        self.assertTrue(self.request("item",{"name":"Farine","unit":"kg"},self.mag)["ok"])
        s=self.request("state",token=self.mag)
        supplier=s["suppliers"][0]["id"];item=s["items"][0]["id"]
        self.request("receipt",{"supplier_id":supplier,"reference":"BL-001","lines":[{"item_id":item,"quantity":10,"unit_cost":100}]},self.mag)
        self.assertEqual(self.request("state",token=self.mag)["items"][0]["stock"],10)
        self.assertEqual(self.request("issue",{"service":"cuisine","item_id":item,"quantity":11},self.mag)["status"],409)
        self.request("issue",{"service":"cuisine","item_id":item,"quantity":3},self.mag)
        self.assertEqual(self.request("state",token=self.mag)["items"][0]["stock"],7)
        self.request("invoice",{"supplier_id":supplier,"reference":"F-001","amount":1000},self.mag)
        invoice=self.request("state",token=self.mag)["invoices"][0]["id"]
        rid=self.request("request",{"lines":[invoice]},self.mag)["id"]
        self.assertEqual(self.request("request",{"lines":[invoice]},self.mag)["status"],409)
        self.assertEqual(self.request("payment",{"invoice_id":invoice,"amount":200,"mode":"Espèces"},self.dir)["status"],409)
        self.assertTrue(self.request("request/review",{"request_id":rid,"status":"approuvee"},self.dir)["ok"])
        self.assertTrue(self.request("payment",{"invoice_id":invoice,"amount":200,"mode":"Espèces"},self.dir)["ok"])
        self.assertEqual(self.request("state",token=self.dir)["invoices"][0]["due"],800)
        self.assertEqual(self.request("payment",{"invoice_id":invoice,"amount":801,"mode":"Espèces"},self.dir)["status"],409)
        self.assertTrue(self.request("payment",{"invoice_id":invoice,"amount":800,"mode":"Espèces"},self.dir)["ok"])
        self.assertEqual(self.request("state",token=self.dir)["invoices"][0]["due"],0)
    def test_03_duplicate_receipt(self):
        s=self.request("state",token=self.mag)
        supplier=s["suppliers"][0]["id"];item=s["items"][0]["id"]
        r=self.request("receipt",{"supplier_id":supplier,"reference":"BL-001","lines":[{"item_id":item,"quantity":10,"unit_cost":100}]},self.mag)
        self.assertEqual(r["status"],409)
        self.assertEqual(self.request("state",token=self.mag)["items"][0]["stock"],7)
if __name__=="__main__":unittest.main()
