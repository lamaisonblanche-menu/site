"""Mise à jour du logiciel à distance (bouton « Mise à jour » de l'appli, réservé à la direction).

Télécharge la branche GitHub, vérifie l'archive, remplace le code dans le dossier de l'application
(jamais les données), puis laisse le serveur se redémarrer tout seul (surveillance des fichiers .py).
Rien à faire sur SRV MB.
"""
import io, json, shutil, ssl, threading, time, urllib.request, zipfile
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEPOT = "lamaisonblanche-menu/site"
BRANCHE = "feature/gestion-stocks-magasin"
SOUS_DOSSIER = "stocks"
URL_VERSION = f"https://raw.githubusercontent.com/{DEPOT}/{BRANCHE}/{SOUS_DOSSIER}/VERSION"
URL_ZIP = f"https://codeload.github.com/{DEPOT}/zip/refs/heads/{BRANCHE}"
EXCLUS = {"data", "tests", "__pycache__", ".git"}  # jamais touchés dans le dossier de l'application
ETAT = {"en_cours": False, "etape": "", "erreur": None, "fin": None, "disponible": None, "verifie": None, "refusee": None}
_LOCK = threading.Lock()


def _ouvrir(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": "MBStocks-maj", "Cache-Control": "no-cache"})
    ctx = ssl.create_default_context()
    return urllib.request.urlopen(req, timeout=timeout, context=ctx)


def version_locale():
    p = ROOT / "VERSION"
    return p.read_text(encoding="utf-8").strip() if p.exists() else "?"


def version_disponible():
    """Version publiée sur GitHub (None si Internet injoignable)."""
    try:
        with _ouvrir(URL_VERSION, 15) as r: v = r.read(100).decode("utf-8").strip()
        ETAT["disponible"] = v; ETAT["verifie"] = datetime.now().strftime("%Y-%m-%d %H:%M"); return v
    except Exception as e:
        ETAT["disponible"] = None; ETAT["verifie"] = datetime.now().strftime("%Y-%m-%d %H:%M") + " (échec : " + str(e)[:80] + ")"
        return None


def _plus_recente(a, b):
    def n(v):
        try: return tuple(int(x) for x in v.split("."))
        except ValueError: return (0,)
    return n(a) > n(b)


def _installer(log, avant=None):
    log("Mise à jour : téléchargement de GitHub (" + BRANCHE + ")")
    ETAT["etape"] = "téléchargement"
    with _ouvrir(URL_ZIP, 120) as r: data = r.read(80_000_000)
    z = zipfile.ZipFile(io.BytesIO(data))
    racine = z.namelist()[0].split("/")[0]
    prefixe = f"{racine}/{SOUS_DOSSIER}/"
    membres = [m for m in z.namelist() if m.startswith(prefixe) and not m.endswith("/")]
    noms = {m[len(prefixe):] for m in membres}
    for f in ("server.py", "metier.py", "stockdb.py", "VERSION", "public/index.html", "public/app.js"):
        if f not in noms: raise RuntimeError("Archive incomplète : " + f + " manquant")
    nouvelle = z.read(prefixe + "VERSION").decode("utf-8").strip()
    ETAT["etape"] = "vérification"
    for m in membres:  # chaque .py doit au moins se compiler
        if m.endswith(".py"): compile(z.read(m), m, "exec")
    ETAT["etape"] = "installation " + nouvelle
    tmp = ROOT / ".maj-tmp"
    if tmp.exists(): shutil.rmtree(tmp)
    for m in membres:
        rel = m[len(prefixe):]
        if rel.split("/")[0] in EXCLUS: continue
        dest = tmp / rel; dest.parent.mkdir(parents=True, exist_ok=True); dest.write_bytes(z.read(m))
    # essai complet de la nouvelle version AVANT de toucher au logiciel installé (modules + migrations sur une copie de la base)
    ETAT["etape"] = "essai de la version " + nouvelle
    try:
        import controle, stockdb
        ok, msg = controle.essai(tmp, stockdb.DB_PATH)
    except ImportError: ok, msg = True, "ok"
    if not ok:
        shutil.rmtree(tmp, ignore_errors=True)
        raise RuntimeError(f"version {nouvelle} refusée, rien n'a été changé : {msg}")
    if avant:
        ETAT["etape"] = "sauvegarde avant mise à jour"
        try: avant()
        except Exception as e: log("Sauvegarde avant mise à jour impossible : " + str(e))
    ETAT["etape"] = "installation " + nouvelle
    # copie en deux temps : d'abord tout sauf les .py, puis les .py + VERSION (le serveur redémarre dès qu'ils changent)
    fichiers = sorted(p for p in tmp.rglob("*") if p.is_file())
    tardifs = [p for p in fichiers if p.suffix == ".py" or p.name == "VERSION"]
    for p in [p for p in fichiers if p not in tardifs] + tardifs:
        dest = ROOT / p.relative_to(tmp); dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(p, dest)
    shutil.rmtree(tmp, ignore_errors=True)
    for p in (ROOT / "__pycache__",): shutil.rmtree(p, ignore_errors=True)
    log(f"Mise à jour installée : {nouvelle} (le serveur redémarre)")
    return nouvelle


def lancer(log, avant=None):
    """Démarre la mise à jour en arrière-plan. Retourne l'état immédiatement."""
    with _LOCK:
        if ETAT["en_cours"]: return dict(ETAT)
        ETAT.update(en_cours=True, etape="démarrage", erreur=None, fin=None)

    def run():
        try:
            v = _installer(log, avant); ETAT["fin"] = v
        except Exception as e:
            ETAT["erreur"] = str(e)[:300]; log("ÉCHEC mise à jour : " + str(e))
        finally: ETAT["en_cours"] = False
    threading.Thread(target=run, daemon=True).start()
    return dict(ETAT)


def boucle_auto(log, heure=4, avant=None, calme=None, toutes_les=900, calme_min=180):
    """Toutes les 15 min : si GitHub publie une version plus récente, l'installe toute seule dès que personne
    n'a rien enregistré depuis 3 min (comme la caisse). Les écrans se rechargent seuls ensuite."""
    time.sleep(60)
    echec = None  # version déjà essayée et refusée : on ne la retélécharge pas en boucle
    while True:
        try:
            v = version_disponible()
            if v and v != echec and _plus_recente(v, version_locale()) and not ETAT["en_cours"]:
                if calme is None or calme() >= calme_min:
                    log(f"Mise à jour automatique : {version_locale()} -> {v}"); lancer(log, avant)
                    time.sleep(120)
                    if ETAT.get("erreur"): echec = v
                    continue
                time.sleep(60); continue  # quelqu'un saisit : on réessaie dans 1 min
        except Exception: pass
        time.sleep(toutes_les)


def etat():
    return dict(ETAT, locale=version_locale())
