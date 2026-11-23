# Caisse La Maison Blanche : consignes pour travailler sur ce projet

Ce document est pour toute IA ou tout développeur qui modifie la caisse (Claude, ChatGPT/Codex…).
À lire en entier avant de toucher à quoi que ce soit.

## 1. C'est quoi

Logiciel de caisse sur mesure du restaurant **La Maison Blanche** (23 rue des Frères Ben Ali, Hydra, Alger).
Il remplace FrontCash. Il est utilisé en service réel : une erreur publiée arrive au restaurant toute seule.

- **Application Windows (Electron)** installée sur le PC de caisse et sur les écrans des salles.
- **PC « Caisse principale »** : fait tourner le serveur Node (données, imprimantes) et l'affiche en plein écran.
- **PC « Écran de salle / cuisine »** : affiche la caisse principale (http://IP:8080) et la trouve seul sur le réseau (UDP 41234).
- Fonctionne **sans internet** : internet sert seulement aux mises à jour.
- Interface et textes **en français**, simples, pour du personnel de salle. Écrans tactiles 1024×768 minimum (HFPOS).
- Monnaie : dinar algérien (DA), entiers. Paiement le plus courant : **espèces**.

## 2. Où est le code

Dépôt GitHub : `lamaisonblanche-menu/site`, **branche `caisse` uniquement**.

> ⚠️ La branche `main` de ce dépôt est le **site web public du restaurant** (lamaisonblanchehydra.com).
> Ne jamais modifier `main`, ne jamais fusionner `caisse` dans `main` ni l'inverse.

```
AGENTS.md            ce document
README.md
app/                 code source
  main.js            coquille Electron (mode principale/poste, lancement du serveur, mises à jour, découverte réseau)
  maj.js             téléchargement + vérification SHA-256 des mises à jour du cœur
  preload.js         pont window.caisseApp (quitter, réglages du PC, dossier des données…)
  setup.html         écran du premier lancement (choix principale / écran de salle)
  attente.html       écran « connexion à la caisse principale… »
  outils/publier.js  publie app/core vers maj/ (calcule les empreintes)
  outils/installeur.nsi, outils/icone-exe.js   fabrication de l'installateur Windows
  core/              LE CŒUR DE LA CAISSE (c'est presque toujours ici qu'on travaille)
    VERSION          numéro de version du cœur (ex. 3.2.0)
    server.js        serveur Node sans dépendance : API, données JSON, impressions ESC/POS
    seed-menu.json   carte de départ (seulement pour une installation neuve)
    logo-ticket.bin  logo imprimé sur les tickets (image 1 bit)
    public/index.html, app.js, style.css, logo.png   interface (JS natif, sans framework ni build)
maj/                 DERNIÈRE VERSION PUBLIÉE du cœur, lue par les caisses du restaurant
  version.json       { version, date, notes, fichiers: [{chemin, sha256}] }
  core/…             copie exacte de app/core au moment de la publication
```

## 3. Comment les mises à jour arrivent au restaurant

1. Toutes les 15 min, la caisse principale lit
   `https://raw.githubusercontent.com/lamaisonblanche-menu/site/caisse/maj/version.json`.
2. Si `version` est plus grande que la sienne, elle télécharge chaque fichier de `maj/core/`
   et vérifie son SHA-256. Un seul fichier faux = mise à jour refusée.
3. Elle l'installe quand personne n'a touché la caisse depuis 3 min (`GET /api/calme`, qui sauvegarde les données ;
   depuis 3.4.0 les tables ouvertes n'empêchent plus l'installation, elles sont gardées). « Installer maintenant » dans Gestion → Réglages force l'installation, puis redémarre le serveur. Les écrans de salle se rechargent seuls (`/api/version`).
4. Si la nouvelle version **plante 2 fois au démarrage**, elle est abandonnée et la caisse revient à l'ancienne.
   ⚠️ Une erreur JavaScript dans l'interface (app.js) ne fait PAS planter le serveur : il n'y a aucun retour
   en arrière automatique dans ce cas. Il faut donc tester avant de publier.

Seul `app/core/` se met à jour à distance. Toute modification de `app/main.js`, `maj.js`, `preload.js`,
`setup.html`, `attente.html` demande un **nouvel installateur** (à éviter, à signaler au patron).

## 4. Règles pour modifier (obligatoire)

1. `git pull` de la branche `caisse` avant de commencer : deux IA travaillent dessus.
2. Modifier **`app/core/`** (jamais `maj/` à la main).
3. Tester en local :
   ```
   cd app/core
   CAISSE_DATA=/tmp/test-caisse PORT=8080 node server.js
   # ouvrir http://localhost:8080 — codes : responsable 1234, caisse 1111, serveur 2222
   node --check server.js && node --check public/app.js
   ```
   Faire au moins : ouvrir une table, ajouter des plats (dont une viande → cuisson obligatoire), Envoyer,
   Encaisser en espèces, vérifier les impressions simulées dans `/tmp/test-caisse/impressions-simulees/`.
   Ne jamais commiter de dossier `data/` (il contient les vraies ventes au restaurant, pas dans git).
4. Augmenter `app/core/VERSION` (3.2.0 → 3.2.1 pour une correction, 3.3.0 pour une nouveauté).
5. Publier : `cd app && node outils/publier.js "Ce qui change, en français, en une phrase"`
6. Commit (message en français) + `git push origin caisse`.
7. **Ne jamais republier un numéro déjà publié**, et ne jamais publier une version plus petite.
8. Garder la compatibilité des données : le fichier `data/caisse.json` du restaurant contient des mois de ventes.
   Toute nouvelle donnée passe par une migration dans server.js (voir les blocs `if (db.version < N)`),
   sans jamais supprimer ou renommer un champ existant.

## 5. Ce que fait la caisse (version 3.2.3)

- **Plans de salle** repris de FrontCash : Gastro (1-12, 14-18), Brunch (20-38), Terrasse (100-129), modifiables (glisser-déposer).
- **Onglet À emporter** : commandes E1, E2… par journée, nom/téléphone client, heure de retrait. Vente rapide au comptoir.
- **Prise de commande** : ticket à gauche rangé par suite (Direct, Entrées, Plats, Desserts), carte à droite par
  onglets (Brunch, La carte, Asiatique, Desserts, Boissons, ★ Top). Appui long ou ✎ = fiche du plat :
  options (cuisson obligatoire sur les viandes), commentaires rapides, texte libre avec clavier à l'écran,
  à emporter par plat, suite. Note pour toute la commande. Réclame des suites.
- **Encaissement** : espèces en 2 gestes (compte juste, billets suggérés, rendu en grand), TPE, chèque, facture société,
  offert (code responsable), plusieurs paiements, partage ÷N, séparation par articles, remise (code responsable).
- **Imprimantes ESC/POS**, en réseau (IP, port 9100) ou **en USB sur le PC de caisse** (type `usb` : envoi brut par le spouleur Windows via `core/impression-usb.ps1`, nom de l'imprimante Windows dans `windows`). L'imprimante des tickets (`ticket`) est en USB. 5 postes : `ticket` (caisse + tiroir), `cuisine` (principale), `cuisine2`,
  `asiatique`, `comptoir`. Chaque groupe de la carte choisit son imprimante. Bons groupés par suite, réclame,
  messages, annulations, addition, ticket avec logo + QR code, rapport X, rapport Z.
  Sans IP configurée, les impressions sont écrites dans `data/impressions-simulees/`.
- **Écran cuisine** (rôle « cuisine ») : bons par poste, couleurs selon l'attente, bouton PRÊT → cloche chez le serveur, ruptures.
- **Annulation d'un plat déjà envoyé : seuls les caissiers** (et le responsable). Un serveur doit faire passer le badge ou le code d'un caissier.
- **Équipe** : serveurs, caissiers et comptes « cuisine » (bar et cuisine) ajoutés en 3.2.3 (une seule fois, drapeau `db.equipeInitiale`). Codes imposés par le patron en 3.3.3 (drapeau `db.equipe3`) : Mustapha 2000, Zoheir 1993 (chef de rang), Zahir 1996 ; Lyes (maître d’hôtel) 1515 en 3.3.4 (`db.equipe4`).
- **Badges** (lecteur USB qui tape comme un clavier) pour se connecter, autoriser, pointer arrivée/départ.
- **Gestion** : rapports, carte et prix, options, équipe/codes/badges, plans, imprimantes, pointage, réglages, journal.
- **Rase envoyée par mail** (Gmail, mot de passe d'application dans `config.mail`, jamais envoyé aux écrans) au format de la collection `caisse` de l'appli de gestion (ligne `DONNEES-CAISSE {json}`), rangée chaque nuit par une tâche planifiée Claude.
- **Rase** de fin de journée avec écart, sorties de caisse, exports CSV.

## 6. Repères techniques

- `server.js` : une seule base `db` en mémoire, sauvegardée dans `CAISSE_DATA/caisse.json` (+ copie quotidienne).
  Routes dans l'objet `routes` : `'POST /api/...': (body, user, req, query) => …`. Erreur utilisateur : `E('message', code)`.
  Rôles : cuisine 0, serveur 1, caissier 2, admin 3 (`peut(u, 'caissier')`). Les écrans sont prévenus par SSE (`/api/events`).
- Impression : classe `Doc` (texte, `bold`, `size`, `center`, `lr`, `qr`, `logo`, `cut`, `drawer`) puis `imprimer(poste, doc)`.
- `public/app.js` : état global `S`, actions dans l'objet `A` (appelées par `onclick="A.xxx()"`), rendu complet par `render()`.
  Fonctions de vue : `viewTables`, `viewCommande`, `viewCaisse`, `viewKds`, `viewAdmin`. Fenêtres : `modal()`.
- Pas de dépendance npm dans `core/` : garder ça ainsi (le cœur est téléchargé tel quel).

## 7. Ce qui reste à faire / à savoir

- La carte a été reprise du site (sushis, rolls et lattes en 3.3.1 ; Rigatoni au saumon et Cromesquis d’escargots en 3.3.2). Il manque des groupes de FrontCash (Plats traditionnels, Formules, Suppléments).
- Aucun groupe n'est encore envoyé sur l'imprimante « Cuisine 2 » : c'est au patron de dire lesquels.
- 3.3.5 (`db.postes5`) : groupes « Desserts » (desserts du brunch + Fondant chocolat glace) et « Crêpes et gaufres » imprimés au **comptoir** ; desserts gastro (profiteroles, pavlova, crème brûlée, nougat) dans le groupe « Desserts de la carte », en cuisine.
- 3.3.6 (`db.partout6`) : champ produit `partout: true` → le bon sort sur toutes les imprimantes de bons branchées (`postesDe(pid)`). Activé pour NY roll (×2), Pavlova, Profiteroles, Mochis glacés.
- 3.3.7 : commande commune (asiatique + cuisine/cuisine2 dans le même envoi) → chaque bon de cuisine ajoute en bas « POUR INFO - FAIT PAR … » avec la partie de l'autre cuisine (`bon(…, infos)`), à l'envoi seulement (pas sur l'écran cuisine).
- 3.3.8 (`db.postes8`) : champ produit `postes: ['cuisine','comptoir']` → bon sur ces imprimantes précises. Fondant chocolat glace et Nougat glacé : cuisine + comptoir.
- 3.3.9 (`db.boissons9`) : Eau minérale / pétillante PM 150 et GM 200 ; « Soda » désactivé, remplacé par Coca, Coca zéro, Selecto, Hamoud blanche (250) ; Sprite et Schweppes 250 en 3.3.10 (`db.boissons10`). Prix confirmés par le patron : Piña colada 700, Matcha latte 900.
- **Pointage** : seulement sur la caisse principale (requête venant de 127.0.0.1) ; le bouton est caché sur les écrans de salle et l'API refuse.
- Pas encore testé sur les vraies imprimantes ni sur Windows au restaurant.
- Le patron ne code pas : expliquer simplement, en français, ce qui a changé et ce qu'il doit faire.
