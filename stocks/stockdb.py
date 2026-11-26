"""Base de données du logiciel de stocks La Maison Blanche.

Conventions (à respecter partout) :
- quantités : entiers en MILLIÈMES de l'unité de base de l'article (1 kg = 1000) ;
- montants   : entiers en CENTIMES de dinar (1 DA = 100) ;
- dates      : heure locale de SRV MB, texte « AAAA-MM-JJ HH:MM:SS » ;
- les mouvements de stock, les paiements et le journal ne sont JAMAIS modifiés ni
  supprimés (déclencheurs SQLite) : une erreur se corrige par une contre-écriture.
"""
import hashlib, json, os, sqlite3, threading
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get("MB_STOCKS_DATA", str(ROOT / "data")))
DB_PATH = Path(os.environ.get("MB_STOCKS_DB", str(DATA / "stocks.sqlite3")))
WRITE_LOCK = threading.RLock()
SERVICES = {"cuisine": "Cuisine", "asiatique": "Asiatique", "brunch": "Brunch", "comptoir": "Comptoir / Bar", "patisserie": "Pâtisserie"}
BASE_UNITS = {"kg": "kilogramme", "L": "litre", "u": "unité"}
# Conversions standard proposées pour chaque unité de base (facteur = combien d'unités de base)
STD_UNITS = {"kg": {"kg": 1, "g": 0.001}, "L": {"L": 1, "cL": 0.01, "mL": 0.001}, "u": {"u": 1}}


def set_paths(data_dir=None, db_path=None):
    global DATA, DB_PATH
    if data_dir: DATA = Path(data_dir)
    DB_PATH = Path(db_path) if db_path else DATA / "stocks.sqlite3"


def now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def connect(path=None):
    p = Path(path or DB_PATH)
    p.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(p, timeout=30, isolation_level=None)  # transactions explicites
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys=ON")
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA synchronous=FULL")
    c.execute("PRAGMA busy_timeout=30000")
    return c


def rows(c, sql, args=()):
    return [dict(r) for r in c.execute(sql, args).fetchall()]


def one(c, sql, args=()):
    r = c.execute(sql, args).fetchone()
    return dict(r) if r else None


def val(c, sql, args=()):
    r = c.execute(sql, args).fetchone()
    return r[0] if r else None


SCHEMA_V1 = """
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE users(
  id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('magasinier','direction')), salt TEXT NOT NULL, password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, must_change INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE sessions(
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL, last_seen TEXT NOT NULL, ip TEXT);
CREATE TABLE suppliers(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, contact TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE items(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, category TEXT NOT NULL DEFAULT '',
  base_unit TEXT NOT NULL CHECK(base_unit IN ('kg','L','u')), min_qty INTEGER NOT NULL DEFAULT 0 CHECK(min_qty>=0),
  location TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
  qty INTEGER NOT NULL DEFAULT 0 CHECK(qty>=0), value INTEGER NOT NULL DEFAULT 0 CHECK(value>=0),
  last_cost REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE item_units(
  id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id), name TEXT NOT NULL COLLATE NOCASE,
  factor REAL NOT NULL CHECK(factor>0), UNIQUE(item_id,name));
CREATE TABLE receipts(
  id INTEGER PRIMARY KEY, supplier_id INTEGER NOT NULL REFERENCES suppliers(id), number TEXT NOT NULL, number_key TEXT NOT NULL,
  doc_date TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('validee','annulee')), total INTEGER NOT NULL,
  notes TEXT NOT NULL DEFAULT '', duplicate_reason TEXT, created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
  cancelled_by INTEGER REFERENCES users(id), cancelled_at TEXT, cancel_reason TEXT, client_uid TEXT UNIQUE);
CREATE UNIQUE INDEX receipts_unique ON receipts(supplier_id,number_key) WHERE status='validee';
CREATE TABLE receipt_lines(
  id INTEGER PRIMARY KEY, receipt_id INTEGER NOT NULL REFERENCES receipts(id), item_id INTEGER NOT NULL REFERENCES items(id),
  qty_entered REAL NOT NULL CHECK(qty_entered>0), unit_name TEXT NOT NULL, factor REAL NOT NULL CHECK(factor>0),
  qty INTEGER NOT NULL CHECK(qty>0), unit_price INTEGER NOT NULL CHECK(unit_price>=0), discount_pct REAL NOT NULL DEFAULT 0,
  total INTEGER NOT NULL CHECK(total>=0));
CREATE TABLE invoices(
  id INTEGER PRIMARY KEY, supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  kind TEXT NOT NULL CHECK(kind IN ('facture','solde_initial')), number TEXT NOT NULL, number_key TEXT NOT NULL,
  doc_date TEXT NOT NULL, due_date TEXT, amount INTEGER NOT NULL CHECK(amount>0), notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('active','annulee')), duplicate_reason TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
  cancelled_by INTEGER REFERENCES users(id), cancelled_at TEXT, cancel_reason TEXT, client_uid TEXT UNIQUE);
CREATE UNIQUE INDEX invoices_unique ON invoices(supplier_id,number_key) WHERE status='active';
CREATE TABLE invoice_receipts(invoice_id INTEGER NOT NULL REFERENCES invoices(id), receipt_id INTEGER NOT NULL REFERENCES receipts(id),
  PRIMARY KEY(invoice_id,receipt_id));
CREATE UNIQUE INDEX invoice_receipts_once ON invoice_receipts(receipt_id);
CREATE TABLE credit_notes(
  id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id), number TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount>0),
  doc_date TEXT NOT NULL, reason TEXT NOT NULL, created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, client_uid TEXT UNIQUE);
CREATE TABLE issue_slips(
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('sortie','retour_service','perte','retour_fournisseur')),
  service TEXT CHECK(service IS NULL OR service IN ('cuisine','asiatique','brunch','comptoir')),
  supplier_id INTEGER REFERENCES suppliers(id), requested_by TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '',
  total INTEGER NOT NULL DEFAULT 0, created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, client_uid TEXT UNIQUE);
CREATE TABLE stock_movements(
  id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id),
  kind TEXT NOT NULL CHECK(kind IN ('reception','annulation_reception','sortie','retour_service','perte','retour_fournisseur','ajustement')),
  qty INTEGER NOT NULL CHECK(qty<>0), value INTEGER NOT NULL, unit_cost REAL NOT NULL, service TEXT,
  ref_type TEXT NOT NULL, ref_id INTEGER NOT NULL, qty_after INTEGER NOT NULL CHECK(qty_after>=0), value_after INTEGER NOT NULL CHECK(value_after>=0),
  created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
CREATE INDEX mv_item ON stock_movements(item_id,id);
CREATE INDEX mv_date ON stock_movements(created_at);
CREATE TABLE inventories(
  id INTEGER PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('brouillon','soumis','approuve','rejete')),
  note TEXT NOT NULL DEFAULT '', created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, submitted_at TEXT,
  reviewed_by INTEGER REFERENCES users(id), reviewed_at TEXT, review_comment TEXT);
CREATE TABLE inventory_lines(
  id INTEGER PRIMARY KEY, inventory_id INTEGER NOT NULL REFERENCES inventories(id), item_id INTEGER NOT NULL REFERENCES items(id),
  expected INTEGER NOT NULL, counted INTEGER NOT NULL CHECK(counted>=0), reason TEXT NOT NULL DEFAULT '', counted_at TEXT NOT NULL,
  applied_delta INTEGER, applied_value INTEGER, UNIQUE(inventory_id,item_id));
CREATE TABLE payment_requests(
  id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, week_start TEXT NOT NULL, week_end TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('brouillon','soumise','a_corriger','refusee','approuvee','partiellement_payee','payee','cloturee')),
  revision INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '', created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
  submitted_at TEXT, reviewed_by INTEGER REFERENCES users(id), reviewed_at TEXT, review_comment TEXT, closed_at TEXT, client_uid TEXT UNIQUE);
CREATE TABLE payment_request_lines(
  id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES payment_requests(id), invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  due_at_submit INTEGER NOT NULL, requested INTEGER NOT NULL CHECK(requested>0), approved INTEGER, is_old INTEGER NOT NULL DEFAULT 0,
  UNIQUE(request_id,invoice_id));
CREATE TABLE payment_request_revisions(
  id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES payment_requests(id), revision INTEGER NOT NULL,
  event TEXT NOT NULL, snapshot TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id), at TEXT NOT NULL);
CREATE TABLE payments(
  id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id), request_id INTEGER NOT NULL REFERENCES payment_requests(id),
  amount INTEGER NOT NULL CHECK(amount>0), paid_on TEXT NOT NULL, mode TEXT NOT NULL, reference TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '', confirmed_by INTEGER NOT NULL REFERENCES users(id), confirmed_at TEXT NOT NULL, client_uid TEXT UNIQUE);
CREATE TABLE payment_cancellations(
  payment_id INTEGER PRIMARY KEY REFERENCES payments(id), reason TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id), at TEXT NOT NULL);
CREATE TABLE attachments(
  id INTEGER PRIMARY KEY, owner_type TEXT NOT NULL CHECK(owner_type IN ('reception','facture','avoir','paiement','sortie','inventaire','demande')),
  owner_id INTEGER NOT NULL, filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, path TEXT NOT NULL,
  uploaded_by INTEGER NOT NULL REFERENCES users(id), uploaded_at TEXT NOT NULL);
CREATE INDEX att_owner ON attachments(owner_type,owner_id);
CREATE TABLE audit_log(
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, user_id INTEGER, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id INTEGER,
  details TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TRIGGER no_upd_mv BEFORE UPDATE ON stock_movements BEGIN SELECT RAISE(ABORT,'Mouvement immuable'); END;
CREATE TRIGGER no_del_mv BEFORE DELETE ON stock_movements BEGIN SELECT RAISE(ABORT,'Mouvement immuable'); END;
CREATE TRIGGER no_upd_pay BEFORE UPDATE ON payments BEGIN SELECT RAISE(ABORT,'Paiement immuable'); END;
CREATE TRIGGER no_del_pay BEFORE DELETE ON payments BEGIN SELECT RAISE(ABORT,'Paiement immuable'); END;
CREATE TRIGGER no_upd_audit BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT,'Journal immuable'); END;
CREATE TRIGGER no_del_audit BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT,'Journal immuable'); END;
CREATE TRIGGER no_del_receipt BEFORE DELETE ON receipts BEGIN SELECT RAISE(ABORT,'Suppression interdite'); END;
CREATE TRIGGER no_del_invoice BEFORE DELETE ON invoices BEGIN SELECT RAISE(ABORT,'Suppression interdite'); END;
CREATE TRIGGER no_del_rl BEFORE DELETE ON receipt_lines BEGIN SELECT RAISE(ABORT,'Suppression interdite'); END;
CREATE TRIGGER no_upd_rl BEFORE UPDATE ON receipt_lines BEGIN SELECT RAISE(ABORT,'Ligne immuable'); END;
"""

SCHEMA_V2 = """
ALTER TABLE receipts ADD COLUMN divers INTEGER NOT NULL DEFAULT 0;
CREATE TABLE receipt_misc_lines(
  id INTEGER PRIMARY KEY, receipt_id INTEGER NOT NULL REFERENCES receipts(id), label TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount>0));
CREATE TRIGGER no_del_rml BEFORE DELETE ON receipt_misc_lines BEGIN SELECT RAISE(ABORT,'Suppression interdite'); END;
CREATE TRIGGER no_upd_rml BEFORE UPDATE ON receipt_misc_lines BEGIN SELECT RAISE(ABORT,'Ligne immuable'); END;
"""

SCHEMA_V3 = """
CREATE TABLE issue_slips_v3(
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('sortie','retour_service','perte','retour_fournisseur')),
  service TEXT CHECK(service IS NULL OR service IN ('cuisine','asiatique','brunch','comptoir','patisserie')),
  supplier_id INTEGER REFERENCES suppliers(id), requested_by TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '',
  total INTEGER NOT NULL DEFAULT 0, created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, client_uid TEXT UNIQUE);
INSERT INTO issue_slips_v3(id,kind,service,supplier_id,requested_by,reason,total,created_by,created_at,client_uid)
  SELECT id,kind,service,supplier_id,requested_by,reason,total,created_by,created_at,client_uid FROM issue_slips;
DROP TABLE issue_slips;
ALTER TABLE issue_slips_v3 RENAME TO issue_slips;
"""  # v1.7.0 : service Pâtisserie

MIGRATIONS = [SCHEMA_V1, SCHEMA_V2, SCHEMA_V3]  # ajouter ici les migrations suivantes (jamais modifier une migration publiée)

DEFAULT_SETTINGS = {
    "week_start": "0",            # 0 = dimanche … 6 = samedi (semaine algérienne : dimanche → samedi)
    "company": "La Maison Blanche",
    "address": "23 rue des Frères Ben Ali, Hydra, Alger",
    "allowed_networks": "127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16",
    "session_hours": "12",
}


def migrate(c):
    v = c.execute("PRAGMA user_version").fetchone()[0]
    for i in range(v, len(MIGRATIONS)):
        c.execute("BEGIN IMMEDIATE")
        try:
            for stmt in split_sql(MIGRATIONS[i]):
                c.execute(stmt)
            c.execute(f"PRAGMA user_version={i + 1}")
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")
            raise
    for k, v2 in DEFAULT_SETTINGS.items():
        c.execute("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)", (k, v2))


def split_sql(script):
    """Découpe un script SQL en instructions (les déclencheurs contiennent des « ; »)."""
    out, buf = [], ""
    for line in script.strip().splitlines():
        buf += line + "\n"
        if sqlite3.complete_statement(buf):
            out.append(buf.strip()); buf = ""
    if buf.strip(): out.append(buf.strip())
    return out


def init(path=None):
    c = connect(path)
    try: migrate(c)
    finally: c.close()


def setting(c, key):
    v = val(c, "SELECT value FROM settings WHERE key=?", (key,))
    return v if v is not None else DEFAULT_SETTINGS.get(key)


def audit(c, user_id, action, entity, entity_id=None, details=None):
    prev = val(c, "SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1") or "0" * 64
    at = now()
    d = json.dumps(details or {}, ensure_ascii=False, sort_keys=True)
    h = hashlib.sha256(f"{prev}|{at}|{user_id}|{action}|{entity}|{entity_id}|{d}".encode()).hexdigest()
    c.execute("INSERT INTO audit_log(at,user_id,action,entity,entity_id,details,prev_hash,hash) VALUES(?,?,?,?,?,?,?,?)",
              (at, user_id, action, entity, entity_id, d, prev, h))


def verify_audit_chain(c):
    prev = "0" * 64
    for r in c.execute("SELECT * FROM audit_log ORDER BY id"):
        h = hashlib.sha256(f"{prev}|{r['at']}|{r['user_id']}|{r['action']}|{r['entity']}|{r['entity_id']}|{r['details']}".encode()).hexdigest()
        if r["prev_hash"] != prev or r["hash"] != h:
            return False, r["id"]
        prev = r["hash"]
    return True, None
