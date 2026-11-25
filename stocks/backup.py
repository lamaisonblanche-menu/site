#!/usr/bin/env python3
"""Sauvegarde et restauration du logiciel de stocks La Maison Blanche.

  py backup.py sauvegarder [--dest DOSSIER ...]   sauvegarde vérifiée (base + justificatifs) dans un .zip
  py backup.py verifier FICHIER.zip               contrôle une sauvegarde sans rien modifier
  py backup.py restaurer FICHIER.zip [--oui]      restaure (serveur ARRÊTÉ) ; l'état actuel est d'abord mis de côté
  py backup.py liste

La sauvegarde contient : stocks.sqlite3 (copie cohérente via l'API de sauvegarde SQLite), le dossier
justificatifs/, et manifeste.json (empreintes SHA-256, nombre de lignes par table, contrôle d'intégrité).
"""
import argparse, hashlib, json, os, shutil, sqlite3, sys, tempfile, zipfile
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import stockdb as D

TABLES = ["users", "suppliers", "items", "item_units", "receipts", "receipt_lines", "invoices", "invoice_receipts", "credit_notes",
          "issue_slips", "stock_movements", "inventories", "inventory_lines", "payment_requests", "payment_request_lines",
          "payment_request_revisions", "payments", "payment_cancellations", "attachments", "audit_log"]


def default_dir():
    return D.DATA / "sauvegardes"


def counts(conn):
    out = {t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in TABLES}
    out["_stock_qty"] = conn.execute("SELECT COALESCE(SUM(qty),0) FROM items").fetchone()[0]
    out["_stock_value"] = conn.execute("SELECT COALESCE(SUM(value),0) FROM items").fetchone()[0]
    out["_payments"] = conn.execute("SELECT COALESCE(SUM(amount),0) FROM payments").fetchone()[0]
    out["_invoices"] = conn.execute("SELECT COALESCE(SUM(amount),0) FROM invoices WHERE status='active'").fetchone()[0]
    return out


def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""): h.update(b)
    return h.hexdigest()


def create(dest_dirs=None, label="auto"):
    src = D.DB_PATH
    if not src.is_file(): raise RuntimeError("Base introuvable : " + str(src))
    dests = [Path(x) for x in (dest_dirs or [default_dir()])]
    stamp = datetime.now().strftime("%Y-%m-%d_%H%M%S")
    with tempfile.TemporaryDirectory() as tmp:
        snap = Path(tmp) / "stocks.sqlite3"
        s = sqlite3.connect(src, timeout=30); d = sqlite3.connect(snap)
        try:
            s.backup(d)
            ok = d.execute("PRAGMA integrity_check").fetchone()[0]
            if ok != "ok": raise RuntimeError("Contrôle d'intégrité en échec : " + ok)
            fk = d.execute("PRAGMA foreign_key_check").fetchall()
            if fk: raise RuntimeError("Références incohérentes dans la base")
            manifest = {"date": stamp, "label": label, "user_version": d.execute("PRAGMA user_version").fetchone()[0], "counts": counts(d), "files": {}}
        finally:
            s.close(); d.close()
        manifest["files"]["stocks.sqlite3"] = sha(snap)
        att = D.DATA / "justificatifs"
        att_files = [p for p in att.rglob("*") if p.is_file() and p.suffix != ".tmp"] if att.exists() else []
        out_zip = Path(tmp) / f"stocks-{stamp}-{label}.zip"
        with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as z:
            z.write(snap, "stocks.sqlite3")
            for p in att_files:
                rel = "justificatifs/" + p.relative_to(att).as_posix()
                manifest["files"][rel] = sha(p); z.write(p, rel)
            z.writestr("manifeste.json", json.dumps(manifest, ensure_ascii=False, indent=1))
        verify(out_zip)
        written = []
        for dd in dests:
            try:
                dd.mkdir(parents=True, exist_ok=True)
                target = dd / out_zip.name
                shutil.copy2(out_zip, target)
                if sha(target) != sha(out_zip): raise RuntimeError("copie corrompue")
                written.append(str(target))
                prune(dd)
            except Exception as e:
                written.append(f"ÉCHEC {dd} : {e}")
        return {"files": written, "manifest": manifest}


def verify(zpath):
    zpath = Path(zpath)
    with zipfile.ZipFile(zpath) as z:
        bad = z.testzip()
        if bad: raise RuntimeError("Archive endommagée : " + bad)
        m = json.loads(z.read("manifeste.json"))
        with tempfile.TemporaryDirectory() as tmp:
            z.extractall(tmp)
            for rel, h in m["files"].items():
                if sha(Path(tmp) / rel) != h: raise RuntimeError("Empreinte différente : " + rel)
            c = sqlite3.connect(Path(tmp) / "stocks.sqlite3")
            try:
                if c.execute("PRAGMA integrity_check").fetchone()[0] != "ok": raise RuntimeError("Base de la sauvegarde endommagée")
                if counts(c) != m["counts"]: raise RuntimeError("Comptages différents du manifeste")
            finally: c.close()
    return m


def prune(folder, keep_days=30):
    """Garde toutes les sauvegardes des 30 derniers jours + la première de chaque mois (12 derniers mois)."""
    dated = []
    for f in sorted(folder.glob("stocks-*-auto.zip")):
        try: dated.append((datetime.strptime(f.name[7:24], "%Y-%m-%d_%H%M%S"), f))
        except ValueError: pass
    firsts = {}
    for dt, f in dated: firsts.setdefault(dt.strftime("%Y-%m"), f)
    keep = set(list(firsts.values())[-12:])
    limit = datetime.now() - timedelta(days=keep_days)
    for dt, f in dated:
        if dt < limit and f not in keep: f.unlink(missing_ok=True)


def listing(dest=None):
    out = []
    for dd in [Path(x) for x in (dest or [default_dir()])]:
        if dd.exists():
            out += [{"file": str(f), "size": f.stat().st_size, "date": datetime.fromtimestamp(f.stat().st_mtime).strftime("%Y-%m-%d %H:%M")}
                    for f in sorted(dd.glob("stocks-*.zip"), reverse=True)]
    return out


def restore(zpath, data_dir=None):
    """Restaure une sauvegarde. Le serveur doit être arrêté. L'état actuel est conservé dans data/avant-restauration-<date>/."""
    m = verify(zpath)
    data = Path(data_dir or D.DATA)
    keep = data / ("avant-restauration-" + datetime.now().strftime("%Y-%m-%d_%H%M%S"))
    keep.mkdir(parents=True)
    for n in ("stocks.sqlite3", "stocks.sqlite3-wal", "stocks.sqlite3-shm"):
        if (data / n).exists(): shutil.move(str(data / n), keep / n)
    if (data / "justificatifs").exists(): shutil.copytree(data / "justificatifs", keep / "justificatifs")
    with zipfile.ZipFile(zpath) as z:
        z.extract("stocks.sqlite3", data)
        for n in z.namelist():
            if n.startswith("justificatifs/"): z.extract(n, data)
    c = sqlite3.connect(data / "stocks.sqlite3")
    try:
        if counts(c) != m["counts"]: raise RuntimeError("Restauration incomplète")
    finally: c.close()
    return {"restaure": m["date"], "ancien_etat": str(keep), "counts": m["counts"]}


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--data", help="dossier des données (par défaut stocks/data)")
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("sauvegarder"); a.add_argument("--dest", action="append"); a.add_argument("--label", default="manuelle")
    b = sub.add_parser("verifier"); b.add_argument("fichier")
    r = sub.add_parser("restaurer"); r.add_argument("fichier"); r.add_argument("--oui", action="store_true")
    sub.add_parser("liste")
    args = p.parse_args()
    if args.data: D.set_paths(args.data)
    try:
        if args.cmd == "sauvegarder":
            res = create(args.dest, args.label)
            for f in res["files"]: print(f)
            if any(f.startswith("ÉCHEC") for f in res["files"]): sys.exit(2)
        elif args.cmd == "verifier":
            m = verify(args.fichier); print("Sauvegarde valide du", m["date"]); print(json.dumps(m["counts"], indent=1))
        elif args.cmd == "restaurer":
            if not args.oui and input("Le serveur des stocks est-il ARRÊTÉ ? Restaurer ? (oui/non) ").strip().lower() != "oui": sys.exit(1)
            print(json.dumps(restore(args.fichier), ensure_ascii=False, indent=1))
        else:
            for x in listing(): print(x["date"], x["size"], x["file"])
    except Exception as e:
        print("ERREUR :", e, file=sys.stderr); sys.exit(1)


if __name__ == "__main__":
    main()
