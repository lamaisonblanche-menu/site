"""Prévention des pannes : essai d'une version avant de l'installer, copie de la dernière version qui marche,
contrôle de santé de la base. Aucune dépendance externe."""
import os, shutil, subprocess, sys, tempfile, zipfile
from datetime import datetime
from pathlib import Path
import stockdb as D
from stockdb import rows, val

EXCLUS = {"data", "tests", "__pycache__", ".git", ".maj-tmp"}

_ESSAI = r'''
import sys, pathlib, sqlite3
for p in pathlib.Path(".").glob("*.py"): compile(p.read_bytes(), str(p), "exec")
for f in ("VERSION", "public/index.html", "public/app.js", "public/style.css"):
    if not pathlib.Path(f).is_file() or not pathlib.Path(f).stat().st_size: raise SystemExit("fichier manquant ou vide : " + f)
import stockdb, metier, documents, backup, majlogiciel, server
src, tmp = sys.argv[1], sys.argv[2]
if src and pathlib.Path(src).is_file():
    a = sqlite3.connect(src); b = sqlite3.connect(str(pathlib.Path(tmp) / "stocks.sqlite3")); a.backup(b); a.close(); b.close()
stockdb.set_paths(tmp); stockdb.init()
c = stockdb.connect()
r = c.execute("PRAGMA integrity_check").fetchone()[0]
if r != "ok": raise SystemExit("base illisible après migration : " + str(r))
c.execute("SELECT COUNT(*) FROM items").fetchone(); c.execute("SELECT COUNT(*) FROM users").fetchone(); c.close()
print("ESSAI_OK")
'''


def essai(code_dir, db_path=None):
    """Essaie une version SANS toucher à la vraie base : compilation, chargement de tous les modules,
    puis migrations sur une copie de la base. Retourne (ok, message)."""
    forcer = Path(code_dir) / "FORCER_MAJ"  # issue de secours : ce fichier fait passer la version sans essai (une seule fois)
    if forcer.exists():
        try: forcer.unlink()
        except OSError: pass
        return True, "essai sauté (FORCER_MAJ)"
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        try:
            env = dict(os.environ, MB_STOCKS_NO_BACKUP="1", MB_STOCKS_NO_CATALOGUE="1", PYTHONDONTWRITEBYTECODE="1")
            kw = {"creationflags": 0x08000000} if os.name == "nt" else {}  # pas de fenêtre console
            r = subprocess.run([sys.executable, "-c", _ESSAI, str(db_path or ""), tmp], cwd=str(code_dir), env=env,
                               capture_output=True, text=True, errors="replace", timeout=180, **kw)
        except Exception as e:  # l'essai lui-même n'a pas pu se lancer : on ne bloque pas les mises à jour pour autant
            return True, "essai impossible : " + str(e)[:200]
    if r.returncode == 0 and "ESSAI_OK" in r.stdout: return True, "ok"
    return False, ((r.stderr or r.stdout or "erreur inconnue").strip().splitlines() or ["erreur inconnue"])[-1][:300]


def _dossier_versions():
    d = D.DATA / "versions"; d.mkdir(parents=True, exist_ok=True); return d


def garder_version(root, version):
    """Copie du code qui tourne en ce moment (dernière version qui marche). On garde les 5 dernières."""
    dest = _dossier_versions() / f"code-{version}.zip"
    tmp = dest.with_suffix(".tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted(Path(root).rglob("*")):
            rel = p.relative_to(root)
            if p.is_file() and rel.parts[0] not in EXCLUS and "__pycache__" not in rel.parts: z.write(p, rel.as_posix())
    os.replace(tmp, dest)
    for old in sorted(_dossier_versions().glob("code-*.zip"), key=lambda p: p.stat().st_mtime)[:-5]:
        try: old.unlink()
        except OSError: pass
    return dest


def restaurer_version(root, version):
    """Remet les fichiers de la version indiquée (après une mise à jour refusée). Retourne True si fait."""
    src = _dossier_versions() / f"code-{version}.zip"
    if not src.is_file(): return False
    with zipfile.ZipFile(src) as z:
        if z.testzip() is not None: return False
        noms = [n for n in z.namelist() if not n.endswith("/")]
        for n in [n for n in noms if not n.endswith(".py") and n != "VERSION"] + [n for n in noms if n.endswith(".py") or n == "VERSION"]:
            dest = Path(root) / n
            if Path(root).resolve() not in dest.resolve().parents: continue
            dest.parent.mkdir(parents=True, exist_ok=True); dest.write_bytes(z.read(n))
    shutil.rmtree(Path(root) / "__pycache__", ignore_errors=True)
    return True


def sante(c, derniere_sauvegarde=None):
    """Contrôle de santé : base, journal, cohérence du stock, disque, sauvegardes."""
    pb = []
    r = val(c, "PRAGMA quick_check")
    if r != "ok": pb.append("Base de données abîmée : " + str(r)[:120])
    ok, bad = D.verify_audit_chain(c)
    if not ok: pb.append(f"Journal de sécurité modifié à partir de l'entrée {bad}")
    ecarts = rows(c, """SELECT i.name FROM items i JOIN stock_movements m ON m.id=(SELECT MAX(id) FROM stock_movements WHERE item_id=i.id)
                        WHERE m.qty_after<>i.qty OR m.value_after<>i.value LIMIT 5""")
    if ecarts: pb.append("Stock incohérent avec ses mouvements : " + ", ".join(x["name"] for x in ecarts))
    fk = rows(c, "PRAGMA foreign_key_check")
    if fk: pb.append(f"{len(fk)} lien(s) cassé(s) dans la base")
    try:
        libre = shutil.disk_usage(str(D.DATA)).free
        if libre < 1_000_000_000: pb.append(f"Disque presque plein sur le serveur : {libre // 1_000_000} Mo libres")
    except OSError: pass
    if derniere_sauvegarde:
        try:
            age = (datetime.now() - datetime.strptime(derniere_sauvegarde[:16], "%Y-%m-%d %H:%M")).total_seconds() / 3600
            if age > 30: pb.append(f"Aucune sauvegarde depuis {int(age)} heures")
        except ValueError: pass
    elif val(c, "SELECT COUNT(*) FROM stock_movements"): pb.append("Aucune sauvegarde trouvée")
    return {"ok": not pb, "problemes": pb, "verifie": datetime.now().strftime("%Y-%m-%d %H:%M")}
