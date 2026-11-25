#!/usr/bin/env python3
"""Prototype autonome de gestion des stocks La Maison Blanche.
Démarrage: python stocks/server.py --host 127.0.0.1 --port 8765
Déploiement LAN uniquement après configuration des comptes et du pare-feu.
"""
import argparse, hashlib, hmac, json, os, secrets, sqlite3, threading, ssl, time
from datetime import timedelta
from decimal import Decimal, InvalidOperation
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT=Path(__file__).resolve().parent
DB=Path(os.environ.get("MB_STOCKS_DB",str(ROOT/"data"/"stocks.sqlite3")))
LOCK=threading.RLock()
SESSIONS={}
ATTEMPTS={}
AUTH_LOCK=threading.Lock()
def now(): return datetime.now(timezone.utc).isoformat(timespec="microseconds")
def conn():
    DB.parent.mkdir(parents=True,exist_ok=True)
    c=sqlite3.connect(DB,timeout=20)
    c.row_factory=sqlite3.Row
    c.execute("PRAGMA foreign_keys=ON")
    c.execute("PRAGMA journal_mode=WAL")
    return c
def init():
    with conn() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,username TEXT UNIQUE NOT NULL,role TEXT NOT NULL CHECK(role IN ('magasinier','direction')),salt TEXT NOT NULL,password_hash TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS suppliers(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE);
        CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,unit TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS receipts(id INTEGER PRIMARY KEY,supplier_id INTEGER NOT NULL REFERENCES suppliers(id),reference TEXT NOT NULL,received_at TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),UNIQUE(supplier_id,reference));
        CREATE TABLE IF NOT EXISTS receipt_lines(id INTEGER PRIMARY KEY,receipt_id INTEGER NOT NULL REFERENCES receipts(id),item_id INTEGER NOT NULL REFERENCES items(id),quantity REAL NOT NULL CHECK(quantity>0),unit_cost INTEGER NOT NULL CHECK(unit_cost>=0));
        CREATE TABLE IF NOT EXISTS issues(id INTEGER PRIMARY KEY,service TEXT NOT NULL CHECK(service IN ('cuisine','asiatique','brunch','comptoir')),item_id INTEGER NOT NULL REFERENCES items(id),quantity REAL NOT NULL CHECK(quantity>0),created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS invoices(id INTEGER PRIMARY KEY,supplier_id INTEGER NOT NULL REFERENCES suppliers(id),reference TEXT NOT NULL,amount INTEGER NOT NULL CHECK(amount>0),created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,UNIQUE(supplier_id,reference));
        CREATE TABLE IF NOT EXISTS payment_requests(id INTEGER PRIMARY KEY,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'soumise' CHECK(status IN ('soumise','approuvee','refusee')),reviewed_by INTEGER REFERENCES users(id),reviewed_at TEXT);
        CREATE TABLE IF NOT EXISTS request_lines(request_id INTEGER NOT NULL REFERENCES payment_requests(id),invoice_id INTEGER NOT NULL REFERENCES invoices(id),amount INTEGER NOT NULL CHECK(amount>0),PRIMARY KEY(request_id,invoice_id));
        CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY,invoice_id INTEGER NOT NULL REFERENCES invoices(id),amount INTEGER NOT NULL CHECK(amount>0),mode TEXT NOT NULL,reference TEXT,paid_by INTEGER NOT NULL REFERENCES users(id),paid_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,actor INTEGER NOT NULL,action TEXT NOT NULL,details TEXT NOT NULL,at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS inventory(id INTEGER PRIMARY KEY,item_id INTEGER NOT NULL REFERENCES items(id),counted REAL NOT NULL,expected REAL NOT NULL,delta REAL NOT NULL,reason TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,approved_by INTEGER REFERENCES users(id),approved_at TEXT);
        """)
        if "unit_cost" not in {r[1] for r in c.execute("PRAGMA table_info(issues)")}: c.execute("ALTER TABLE issues ADD COLUMN unit_cost REAL NOT NULL DEFAULT 0")
        if "receipt_id" not in {r[1] for r in c.execute("PRAGMA table_info(invoices)")}: c.execute("ALTER TABLE invoices ADD COLUMN receipt_id INTEGER REFERENCES receipts(id)")
        c.execute("CREATE UNIQUE INDEX IF NOT EXISTS invoice_receipt_unique ON invoices(receipt_id) WHERE receipt_id IS NOT NULL")
def hashpass(password,salt): return hashlib.pbkdf2_hmac('sha256',password.encode(),bytes.fromhex(salt),250000).hex()
def seed_user(username,role,password):
    if len(password)<12: raise ValueError("Mot de passe : 12 caractères minimum")
    with conn() as c:
        if c.execute("SELECT 1 FROM users WHERE username=?",(username,)).fetchone(): raise ValueError("Compte existant")
        salt=secrets.token_hex(16)
        c.execute("INSERT INTO users(username,role,salt,password_hash) VALUES(?,?,?,?)",(username,role,salt,hashpass(password,salt)))
def fail(msg,status=400): raise APIError(msg,status)
class APIError(Exception):
    def __init__(self,msg,status=400): super().__init__(msg);self.status=status
def audit(c,u,action,details): c.execute("INSERT INTO audit(actor,action,details,at) VALUES(?,?,?,?)",(u["id"],action,json.dumps(details,ensure_ascii=False),now()))
def balance(c,item):
    bought=c.execute("SELECT COALESCE(SUM(quantity),0) FROM receipt_lines WHERE item_id=?",(item,)).fetchone()[0]
    issued=c.execute("SELECT COALESCE(SUM(quantity),0) FROM issues WHERE item_id=?",(item,)).fetchone()[0]
    adjusted=c.execute("SELECT COALESCE(SUM(delta),0) FROM inventory WHERE item_id=? AND approved_at IS NOT NULL",(item,)).fetchone()[0]
    return round(bought-issued+adjusted,3)
def due(c,invoice):
    inv=c.execute("SELECT amount FROM invoices WHERE id=?",(invoice,)).fetchone()
    if not inv: fail("Facture inconnue",404)
    paid=c.execute("SELECT COALESCE(SUM(amount),0) FROM payments WHERE invoice_id=?",(invoice,)).fetchone()[0]
    return inv[0]-paid
def number(d,k,minval=1):
    try:
        raw=Decimal(str(d[k])); v=int(raw)
        if raw!=v: fail("Nombre entier requis : "+k)
    except (KeyError,ValueError,TypeError,InvalidOperation,OverflowError): fail("Valeur invalide : "+k)
    if v<minval: fail("Valeur invalide : "+k)
    return v
def positive_quantity(d):
    try: q=float(d["quantity"])
    except (KeyError,ValueError,TypeError): fail("Quantité invalide")
    if not (0<q<100000000) or round(q,3)!=q: fail("Quantité invalide")
    return q
def textfield(d,k,maxlen=120):
    v=str(d.get(k,"")).strip()
    if not v or len(v)>maxlen: fail("Champ invalide : "+k)
    return v
def average_cost(c,item):
    events=rows(c,"SELECT r.received_at at,0 kind,l.id id,l.quantity q,l.unit_cost cost FROM receipt_lines l JOIN receipts r ON r.id=l.receipt_id WHERE l.item_id=? UNION ALL SELECT created_at,1,id,quantity,unit_cost FROM issues WHERE item_id=? UNION ALL SELECT approved_at,2,id,delta,0 FROM inventory WHERE item_id=? AND approved_at IS NOT NULL ORDER BY at,kind,id",(item,item,item))
    qty=0.0; avg=0.0
    for e in events:
        q=e["q"]
        if e["kind"]==0:
            avg=(qty*avg+q*e["cost"])/(qty+q) if qty+q>0 else 0
            qty+=q
        elif e["kind"]==1: qty-=q
        else: qty+=q
        if qty<=0: qty=0;avg=0
    return round(avg,4)
def rows(c,sql,args=()): return [dict(r) for r in c.execute(sql,args).fetchall()]
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def send(self,status,data):
        b=json.dumps(data,ensure_ascii=False).encode()
        self.send_response(status);self.send_header("Content-Type","application/json; charset=utf-8")
        self.send_header("Cache-Control","no-store");self.send_header("X-Content-Type-Options","nosniff")
        self.send_header("Content-Length",str(len(b)));self.end_headers();self.wfile.write(b)
    def do_GET(self):
        p=urlparse(self.path).path
        if p=="/":
            b=(ROOT/"public"/"index.html").read_bytes()
            self.send_response(200);self.send_header("Content-Type","text/html; charset=utf-8");self.send_header("Content-Length",str(len(b)));self.send_header("Cache-Control","no-store");self.end_headers();self.wfile.write(b);return
        try: self.send(200,self.api("GET",p,{}))
        except APIError as e: self.send(e.status,{"erreur":str(e)})
        except Exception: self.send(500,{"erreur":"Erreur interne"})
    def do_POST(self):
        try:
            n=int(self.headers.get("Content-Length","0"))
            if n<=0 or n>100000: fail("Corps invalide",413)
            d=json.loads(self.rfile.read(n))
            if not isinstance(d,dict): fail("Objet JSON attendu")
            self.send(200,self.api("POST",urlparse(self.path).path,d))
        except APIError as e:self.send(e.status,{"erreur":str(e)})
        except (ValueError,json.JSONDecodeError):self.send(400,{"erreur":"JSON invalide"})
        except sqlite3.IntegrityError:self.send(409,{"erreur":"Doublon ou référence invalide"})
        except Exception:self.send(500,{"erreur":"Erreur interne"})
    def api(self,method,p,d):
        if p=="/api/login" and method=="POST":
            name=textfield(d,"username",60);password=str(d.get("password",""))
            key=self.client_address[0]
            with AUTH_LOCK:
                t=time.monotonic(); recent=[x for x in ATTEMPTS.get(key,[]) if t-x<300]
                if len(recent)>=12: fail("Trop de tentatives. Réessayez dans cinq minutes.",429)
                ATTEMPTS[key]=recent+[t]
            with conn() as c: u=c.execute("SELECT * FROM users WHERE username=?",(name,)).fetchone()
            if not u or not hmac.compare_digest(hashpass(password,u["salt"]),u["password_hash"]): fail("Identifiants incorrects",401)
            with AUTH_LOCK:
                ATTEMPTS.pop(key,None)
                t=time.time()
                for old,session in list(SESSIONS.items()):
                    if session[1]<t: SESSIONS.pop(old,None)
                token=secrets.token_urlsafe(32);SESSIONS[token]=(u["id"],t+8*3600)
            return {"token":token,"role":u["role"]}
        token=self.headers.get("Authorization","").removeprefix("Bearer ").strip()
        sess=SESSIONS.get(token)
        if not sess or sess[1]<datetime.now(timezone.utc).timestamp(): fail("Connexion requise",401)
        if p=="/api/logout" and method=="POST":
            with AUTH_LOCK: SESSIONS.pop(token,None)
            return {"ok":True}
        with LOCK,conn() as c:
            if method=="POST": c.execute("BEGIN IMMEDIATE")
            u=c.execute("SELECT id,username,role FROM users WHERE id=?",(sess[0],)).fetchone()
            if not u: fail("Compte inconnu",401)
            def direction():
                if u["role"]!="direction": fail("Réservé à la direction",403)
            def magasinier():
                if u["role"]!="magasinier": fail("Réservé au magasinier",403)
            if method=="GET" and p.startswith("/api/request-detail/"):
                rid=number({"id":p.rsplit("/",1)[1]},"id")
                request=c.execute("SELECT r.*,u.username author FROM payment_requests r JOIN users u ON u.id=r.created_by WHERE r.id=?",(rid,)).fetchone()
                if not request: fail("Demande inconnue",404)
                return {"request":dict(request),"lines":rows(c,"SELECT l.*,i.reference,s.name supplier FROM request_lines l JOIN invoices i ON i.id=l.invoice_id JOIN suppliers s ON s.id=i.supplier_id WHERE l.request_id=? ORDER BY s.name,i.reference",(rid,))}
            if method=="GET" and p.startswith("/api/week/"):
                try: start=datetime.strptime(p.rsplit("/",1)[1],"%Y-%m-%d").date()
                except ValueError: fail("Date invalide")
                a=str(start); b=str(start+timedelta(days=7))
                return {"start":a,"end_exclusive":b,"purchases":rows(c,"SELECT s.name supplier,ROUND(SUM(l.quantity*l.unit_cost),2) amount FROM receipts r JOIN receipt_lines l ON l.receipt_id=r.id JOIN suppliers s ON s.id=r.supplier_id WHERE date(r.received_at,'+1 hour')>=? AND date(r.received_at,'+1 hour')<? GROUP BY s.id",(a,b)),"issues":rows(c,"SELECT service,ROUND(SUM(quantity*unit_cost),2) amount FROM issues WHERE date(created_at,'+1 hour')>=? AND date(created_at,'+1 hour')<? GROUP BY service",(a,b)),"payments":rows(c,"SELECT s.name supplier,SUM(p.amount) amount FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN suppliers s ON s.id=i.supplier_id WHERE date(p.paid_at,'+1 hour')>=? AND date(p.paid_at,'+1 hour')<? GROUP BY s.id",(a,b)),"debt_now":rows(c,"SELECT s.name supplier,SUM(i.amount-COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id=i.id),0)) amount FROM invoices i JOIN suppliers s ON s.id=i.supplier_id GROUP BY s.id")}
            if method=="GET" and p=="/api/state":
                return {"user":dict(u),"suppliers":rows(c,"SELECT * FROM suppliers ORDER BY name"),"items":[dict(r)|{"stock":balance(c,r["id"]),"unit_cost":average_cost(c,r["id"])} for r in c.execute("SELECT * FROM items ORDER BY name")],"invoices":rows(c,"SELECT i.*,s.name supplier,(i.amount-COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id=i.id),0)) due FROM invoices i JOIN suppliers s ON s.id=i.supplier_id ORDER BY i.id DESC"),"inventory":rows(c,"SELECT v.*,i.name item FROM inventory v JOIN items i ON i.id=v.item_id ORDER BY v.id DESC"),"requests":rows(c,"SELECT r.*,u.username author FROM payment_requests r JOIN users u ON u.id=r.created_by ORDER BY r.id DESC"),"issues":rows(c,"SELECT x.*,i.name item FROM issues x JOIN items i ON i.id=x.item_id ORDER BY x.id DESC LIMIT 100"),"receipts":rows(c,"SELECT r.*,s.name supplier FROM receipts r JOIN suppliers s ON s.id=r.supplier_id ORDER BY r.id DESC LIMIT 100")}
            if method!="POST":fail("Route inconnue",404)
            if p=="/api/supplier":
                name=textfield(d,"name");c.execute("INSERT INTO suppliers(name) VALUES(?)",(name,));audit(c,u,"fournisseur",{"name":name});return {"ok":True}
            if p=="/api/item":
                name=textfield(d,"name");unit=textfield(d,"unit",20)
                c.execute("INSERT INTO items(name,unit) VALUES(?,?)",(name,unit));audit(c,u,"article",{"name":name});return {"ok":True}
            if p=="/api/receipt":
                magasinier()
                supplier=number(d,"supplier_id");ref=textfield(d,"reference");lines=d.get("lines")
                if not isinstance(lines,list) or not lines or len(lines)>100:fail("Lignes de réception invalides")
                c.execute("INSERT INTO receipts(supplier_id,reference,received_at,created_by) VALUES(?,?,?,?)",(supplier,ref,now(),u["id"]))
                rid=c.execute("SELECT last_insert_rowid()").fetchone()[0]
                for x in lines:
                    item=number(x,"item_id");q=positive_quantity(x);cost=number(x,"unit_cost",0)
                    c.execute("INSERT INTO receipt_lines(receipt_id,item_id,quantity,unit_cost) VALUES(?,?,?,?)",(rid,item,q,cost))
                audit(c,u,"reception",{"id":rid});return {"id":rid}
            if p=="/api/issue":
                magasinier()
                service=textfield(d,"service")
                if service not in ("cuisine","asiatique","brunch","comptoir"):fail("Service inconnu")
                item=number(d,"item_id");q=positive_quantity(d)
                if balance(c,item)<q:fail("Stock insuffisant",409)
                c.execute("INSERT INTO issues(service,item_id,quantity,created_by,created_at,unit_cost) VALUES(?,?,?,?,?,?)",(service,item,q,u["id"],now(),average_cost(c,item)))
                audit(c,u,"sortie",{"service":service,"item":item,"quantity":q});return {"ok":True}
            if p=="/api/inventory":
                magasinier(); item=number(d,"item_id"); reason=textfield(d,"reason",500)
                try: counted=float(d["counted"])
                except (KeyError,ValueError,TypeError): fail("Quantité invalide")
                if not 0<=counted<100000000 or round(counted,3)!=counted: fail("Quantité invalide")
                expected=balance(c,item)
                c.execute("INSERT INTO inventory(item_id,counted,expected,delta,reason,created_by,created_at) VALUES(?,?,?,?,?,?,?)",(item,counted,expected,round(counted-expected,3),reason,u["id"],now()))
                audit(c,u,"inventaire_propose",{"item":item,"counted":counted});return {"ok":True}
            if p=="/api/inventory/approve":
                direction(); iid=number(d,"id"); v=c.execute("SELECT * FROM inventory WHERE id=? AND approved_at IS NULL",(iid,)).fetchone()
                if not v: fail("Inventaire indisponible",409)
                if balance(c,v["item_id"])!=v["expected"]: fail("Le stock a changé : refaire le comptage",409)
                c.execute("UPDATE inventory SET approved_at=?,approved_by=? WHERE id=?",(now(),u["id"],iid))
                audit(c,u,"inventaire_approuve",{"id":iid});return {"ok":True}
            if p=="/api/invoice":
                supplier=number(d,"supplier_id");ref=textfield(d,"reference");amount=number(d,"amount")
                receipt=d.get("receipt_id")
                if receipt is not None:
                    receipt=number(d,"receipt_id"); found=c.execute("SELECT supplier_id FROM receipts WHERE id=?",(receipt,)).fetchone()
                    if not found or found[0]!=supplier: fail("Bon incompatible avec le fournisseur")
                c.execute("INSERT INTO invoices(supplier_id,reference,amount,created_by,created_at,receipt_id) VALUES(?,?,?,?,?,?)",(supplier,ref,amount,u["id"],now(),receipt))
                audit(c,u,"facture",{"supplier":supplier,"reference":ref,"amount":amount});return {"ok":True}
            if p=="/api/request":
                magasinier()
                lines=d.get("lines")
                if not isinstance(lines,list) or not lines:fail("Factures manquantes")
                ids=list(dict.fromkeys(number({"id":i},"id") for i in lines))
                if len(ids)!=len(lines):fail("Facture en double")
                for iid in ids:
                    if due(c,iid)<=0:fail("Facture déjà réglée")
                    if c.execute("SELECT 1 FROM request_lines l JOIN payment_requests r ON r.id=l.request_id WHERE l.invoice_id=? AND r.status IN ('soumise','approuvee')",(iid,)).fetchone():fail("Facture déjà dans une demande active",409)
                c.execute("INSERT INTO payment_requests(created_by,created_at) VALUES(?,?)",(u["id"],now()))
                rid=c.execute("SELECT last_insert_rowid()").fetchone()[0]
                for iid in ids:c.execute("INSERT INTO request_lines(request_id,invoice_id,amount) VALUES(?,?,?)",(rid,iid,due(c,iid)))
                audit(c,u,"demande_paiement",{"id":rid,"invoices":ids});return {"id":rid}
            if p=="/api/request/review":
                direction();rid=number(d,"request_id");status=textfield(d,"status")
                if status not in ("approuvee","refusee"):fail("Statut invalide")
                cur=c.execute("UPDATE payment_requests SET status=?,reviewed_by=?,reviewed_at=? WHERE id=? AND status='soumise'",(status,u["id"],now(),rid))
                if not cur.rowcount:fail("Demande non soumise",409)
                audit(c,u,"validation_demande",{"id":rid,"status":status});return {"ok":True}
            if p=="/api/payment":
                direction();iid=number(d,"invoice_id");amount=number(d,"amount");mode=textfield(d,"mode",40)
                if amount>due(c,iid):fail("Montant supérieur au solde",409)
                if not c.execute("SELECT 1 FROM request_lines l JOIN payment_requests r ON r.id=l.request_id WHERE l.invoice_id=? AND r.status='approuvee'",(iid,)).fetchone():fail("Aucune demande approuvée pour cette facture",409)
                c.execute("INSERT INTO payments(invoice_id,amount,mode,reference,paid_by,paid_at) VALUES(?,?,?,?,?,?)",(iid,amount,str(d.get("reference",""))[:120],u["id"],now()))
                audit(c,u,"paiement_confirme",{"invoice":iid,"amount":amount});return {"ok":True}
            fail("Route inconnue",404)
if __name__=="__main__":
    parser=argparse.ArgumentParser();parser.add_argument("--host",default="127.0.0.1");parser.add_argument("--port",type=int,default=8765);parser.add_argument("--cert");parser.add_argument("--key")
    sub=parser.add_subparsers(dest="cmd");add=sub.add_parser("create-user");add.add_argument("username");add.add_argument("role",choices=["magasinier","direction"])
    args=parser.parse_args();init()
    if args.cmd=="create-user":
        import getpass
        seed_user(args.username,args.role,getpass.getpass("Mot de passe : "));print("Compte créé")
    else:
        if args.host not in ("127.0.0.1","localhost") and not (args.cert and args.key): parser.error("TLS obligatoire pour accès réseau")
        server=ThreadingHTTPServer((args.host,args.port),Handler)
        if args.cert and args.key:
            ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);ctx.minimum_version=ssl.TLSVersion.TLSv1_2;ctx.load_cert_chain(args.cert,args.key);server.socket=ctx.wrap_socket(server.socket,server_side=True)
        print("Stocks:",f"{'https' if args.cert and args.key else 'http'}://{args.host}:{args.port}")
        server.serve_forever()
