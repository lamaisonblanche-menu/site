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
CALME_SEC = 180          # comme la caisse : installation après 3 min sans aucune activité
VERIF_SEC = 15 * 60      # vérification de GitHub toutes les 15 min
ACTIVITE = {"t": time.time()}
ETAT = {"attente": None, "en_cours": False, "etape": "", "erreur": None, "fin": None, "disponible": None, "verifie": None, "refusee": None}
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
            ETAT["refusee_version"] = ETAT.get("disponible")  # pas de nouvel essai automatique de la même version
        finally: ETAT["en_cours"] = False
    threading.Thread(target=run, daemon=True).start()
    return dict(ETAT)


def activite():
    """Appelé à chaque saisie / clic sur un écran (et à chaque enregistrement)."""
    ACTIVITE["t"] = time.time()


def boucle_auto(log, heure=4, avant=None):
    """1.7.0 : comme la caisse. Toutes les 15 min, regarde si une version plus récente est publiée sur GitHub ;
    si oui, l'installe dès que personne n'a touché le logiciel depuis 3 min (sauvegarde avant, essai, retour arrière)."""
    time.sleep(60)
    derniere = 0
    while True:
        try:
            if not ETAT["en_cours"]:
                if time.time() - derniere >= VERIF_SEC:
                    derniere = time.time()
                    v = version_disponible()
                    ETAT["attente"] = v if v and _plus_recente(v, version_locale()) and v not in (ETAT.get("refusee_version"), ETAT.get("lancee")) else None
                v = ETAT["attente"]
                if v and time.time() - ACTIVITE["t"] >= CALME_SEC:
                    log(f"Mise à jour automatique (3 min sans activité) : {version_locale()} -> {v}")
                    ETAT["attente"] = None; ETAT["lancee"] = v; lancer(log, avant)
        except Exception: pass
        time.sleep(20)


def etat():
    return dict(ETAT, locale=version_locale())
