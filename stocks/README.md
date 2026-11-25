# Stocks La Maison Blanche — version 1.0.0 (candidate, NON INSTALLÉE)

Logiciel de gestion du magasin central : achats, réceptions, sorties vers les 4 services, inventaires,
factures fournisseurs, demandes de paiement hebdomadaires, paiements confirmés par la direction, rapports.
Indépendant de la caisse (autre dossier, autre port, autre base). Fonctionne sans Internet.

Branche : `feature/gestion-stocks-magasin`. Ne jamais fusionner dans `main` ni `caisse`.

## Architecture
```
SRV MB (Windows 11)                                   PC magasinier
 ├─ C:\MBStocks\app      code (copie de stocks/)        └─ Edge en mode application
 ├─ C:\MBStocks\data     base SQLite + justificatifs        https://SRV-MB:8765  (certificat de
 │   ├─ stocks.sqlite3    (WAL, synchronous=FULL)            l'autorité privée « La Maison Blanche »)
 │   ├─ justificatifs\    photos / PDF (empreinte SHA-256)
 │   ├─ sauvegardes\      .zip vérifiés (+ copie externe)
 │   ├─ tls\              autorité privée + certificat serveur
 │   └─ journaux\         journal technique du serveur
 └─ Tâche planifiée « MB Stocks - Serveur » (SYSTEM, au démarrage, relance auto)
```
- **Python 3.10+ sans dépendance** à l'exécution (le module `cryptography` sert seulement à créer les certificats).
- Un seul serveur écrit dans la base (verrou + transactions `BEGIN IMMEDIATE`) : pas de fichier partagé sur le réseau.
- HTTPS obligatoire dès que le serveur écoute sur le réseau ; seules les adresses du réseau local sont acceptées.

## Fichiers
| Fichier | Rôle |
|---|---|
| `server.py` | serveur HTTP(S), routes, sessions, sauvegardes automatiques |
| `metier.py` | règles métier : CUMP, sorties, doublons, factures, demandes, paiements, inventaires, rapports |
| `stockdb.py` | schéma versionné (migrations), déclencheurs d'immuabilité, journal chaîné |
| `documents.py` | documents imprimables / PDF (Edge sans fenêtre) et exports CSV (Excel FR) |
| `backup.py` | sauvegarde, vérification, restauration |
| `majlogiciel.py` | mise à jour à distance : bouton « Mettre à jour » (Réglages, direction) → téléchargement de la branche GitHub, remplacement du code (jamais `data`), redémarrage automatique ; vérification chaque nuit à 4 h |
| `public/` | interface (HTML/CSS/JS sans framework) |
| `outils/creer_certificats.py` | autorité privée + certificat HTTPS |
| `installation/` | installateurs Windows (serveur, poste), restauration, désinstallation |
| `tests/test_integration.py` | 19 tests automatiques (API, droits, concurrence, pannes, sauvegardes, TLS) |
| `tests/ui_parcours.py` | parcours complet dans le navigateur avec captures d'écran |

## Règles importantes
- Quantités en **millièmes** de l'unité de stock (kg, L ou unité) ; montants en **centimes** de DA : aucun arrondi flottant.
- Valorisation au **coût moyen pondéré** (CUMP) : chaque réception recalcule le coût moyen ; sorties, pertes et
  retours fournisseur sortent au coût moyen ; un stock vidé repart à 0 DA (pas de valeur résiduelle).
- **Mouvements, paiements, lignes de bons et journal sont immuables** (déclencheurs SQLite) : on corrige par
  contre-écriture (annulation de bon, annulation de paiement, ajustement d'inventaire approuvé).
- Achats (bons), factures, paiements et consommation sont **quatre indicateurs distincts**.
- Une **approbation n'est jamais un paiement** : seule la direction confirme un règlement réel, facture par facture.
- Chaque saisie porte un identifiant unique (`client_uid`) : un double clic ou un renvoi après coupure réseau
  ne crée jamais de doublon.

## Développement / tests (données de test uniquement)
```
cd stocks
python -m unittest discover -s tests -v          # 19 tests
python tests/ui_parcours.py --chrome "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"   # nécessite playwright
python server.py --data C:\temp\stocks-test creer-compte direction direction "Direction"
python server.py --data C:\temp\stocks-test        # http://127.0.0.1:8765 (local uniquement)
```

## Installation (APRÈS accord du gérant)
1. Sur SRV MB : copier le dossier `stocks` (ou cloner la branche), puis `installation\Installer le serveur.cmd`
   (option : `-SauvegardeExterne "E:\Sauvegardes-Stocks"`). Le script : Python, copie dans `C:\MBStocks`, droits,
   certificat, pare-feu (réseau local seulement, port 8765), comptes, tâche au démarrage, sauvegarde du soir,
   raccourci bureau, dossier `pour-le-pc-magasinier`.
2. Sur le PC magasinier : copier `C:\MBStocks\pour-le-pc-magasinier` puis lancer `Installer le poste.cmd`
   (autorité de certification, nom du serveur, raccourci Edge).
3. Vérifier que l'empreinte affichée est la même sur les deux PC.

## Retour arrière (rollback)
- `installation\desinstaller.ps1` (administrateur) : retire tâches, pare-feu, raccourci, autorité. Les données restent.
- Restaurer des données : `C:\MBStocks\Restaurer une sauvegarde.cmd` (l'état actuel est conservé dans
  `data\avant-restauration-<date>`).
- La caisse n'est jamais modifiée : aucun retour arrière nécessaire de ce côté.

## Mode hors ligne (v1.1.0)
Le PC magasinier peut saisir **réceptions et sorties/retours/pertes sans Wi-Fi** : l'application s'ouvre quand même
(copie gardée par le navigateur, à condition de l'avoir ouverte une fois connecté), les saisies sont gardées sur le PC
et envoyées automatiquement, dans l'ordre, dès que le serveur répond (au plus tard 30 s après le retour du Wi-Fi).
Chaque saisie porte la mention « saisi hors ligne le … ». Une saisie refusée à l'envoi (ex. stock insuffisant) est
listée dans un bandeau orange « Voir » : la ressaisir corrigée puis la retirer. Les autres pages affichent les
dernières données reçues. Si la session a expiré (12 h), se reconnecter une fois en Wi-Fi : la file est conservée.
