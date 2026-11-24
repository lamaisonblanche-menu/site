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
- **Réservations (3.5.0)** : `db.reservations` [{id R…, date, heure HH:MM, nom, tel, couverts, salle, table, note, statut a_confirmer|prevue|arrivee|annulee|absent, source telephone|site, par}].
  Vue `viewResa` (onglet « Résa » du rail), création/modif réservée aux caissiers (`POST /api/reservation`, conflit de table ±2 h → 409 sauf `forcer`).
  Une table réservée est bloquée (violette, avertissement à l’ouverture) de 30 min avant l’heure à 1 h après (`resaBloquante`) ; l’ouvrir entre -30 min et +90 min la passe en « arrivée » (`arriveeAuto`). Une table bloquée ne peut être ouverte que par un caissier (un serveur doit donner le badge ou code d’un caissier, `pin` dans `POST /api/commande/ouvrir`, 3.5.2).
  Notification : mail au patron (`notifier`, file `db.mailsAttente` renvoyée toutes les 5 min si pas d'internet).
  Site : la caisse lit Gmail en IMAP (`imapLire`, mails de web3forms des 4 derniers jours, toutes les 5 min, même mot de passe d'application) et crée des réservations « à confirmer » (`resaDepuisMail`, déjà lues dans `db.siteVus`).
- **Pointage** : seulement sur la caisse principale (requête venant de 127.0.0.1) ; le bouton est caché sur les écrans de salle et l'API refuse.
- Pas encore testé sur les vraies imprimantes ni sur Windows au restaurant.
- Le patron ne code pas : expliquer simplement, en français, ce qui a changé et ce qu'il doit faire.

## 8. Passation (23/11/2026, version 3.5.2 publiée)

État : caisse lancée au restaurant le 23/11/2026. Versions du jour : 3.3.2 → 3.5.0 (voir `git log`).
Toutes les modifications de la carte ou des codes passent par une **migration avec drapeau** dans server.js
(`if (!db.xxx) { …; db.xxx = true; }`) placée juste avant le bloc « Carte complétée avec le site (version 3.3.1) ».

À faire / en attente du patron :
- Groupes à envoyer sur l'imprimante « Cuisine 2 » (aucun pour l'instant).
- Groupes FrontCash manquants : Plats traditionnels, Formules, Suppléments (le patron doit donner articles + prix).
- Jus de banane : pas sur la carte (prix à demander).
- Sociétés payées par chèque : proposé un récap par société (Gestion → Rapports) + envoi du détail dans le suivi des chèques de l'appli de gestion. Pas encore validé.
- Lyes (maître d'hôtel, code 1515) est « serveur » : il ne peut ni annuler un plat ni prendre une réservation. Le passer en caissier seulement si le patron le demande.
- Réservations : vérifier au restaurant que la lecture IMAP de Gmail marche (Gestion → Réglages : mot de passe d'application Gmail, puis Résa → « Lire maintenant »). En cas d'erreur, le message s'affiche en bas de l'écran Résa.
- Pas encore testé sur les vraies imprimantes ni sur l'imprimante USB des tickets.

Tester avant chaque publication (obligatoire) : `node --check`, une commande complète au navigateur en 1024×768
(ouvrir une table, plats, Envoyer, encaisser en espèces) et lire `impressions-simulees/`.

### Pour ChatGPT / Codex (comment publier)
- Travailler depuis **Codex** (chatgpt.com/codex), environnement relié au dépôt `lamaisonblanche-menu/site`, **branche de base `caisse`**.
- Dans la même pull request : le changement dans `app/core/`, `app/core/VERSION` augmenté, ET le dossier `maj/` régénéré par
  `cd app && node outils/publier.js "notes"`. Sans `maj/`, rien n'arrive au restaurant.
- La pull request doit viser **base: caisse** (jamais `main`). Le patron la fusionne (« Merge pull request ») : c'est ce qui publie.
- Si Claude et Codex travaillent le même jour : toujours repartir de la dernière version de `caisse` et prendre un numéro de version
  plus grand que celui de `maj/version.json`.

Changements du 23/11 au soir (3.4.0 → 3.5.2) :
- 3.4.0 : mise à jour installée même avec des tables ouvertes (après 3 min sans activité) ; « Installer maintenant » toujours possible.
- 3.5.0 : réservations (onglet Résa, téléphone + site via Gmail IMAP, mail au patron).
- 3.5.1 : table réservée bloquée de 30 min avant à 1 h après l'heure.
- 3.5.2 : une table bloquée ne s'ouvre que par un caissier (badge/code d'un caissier pour un serveur).

### 3.5.6 (24/11/2026, Claude) — part de la 3.5.5 de Codex, sans la remplacer
- Groupe d'options « Supplément » : Gruyère et Parmesan ajoutés à 500 DA (l'article `supplement-fixe` de Codex reste pour les autres).
- Sociétés sur facture ajoutées : SPA SGS QUALITEST ALGERIE, ALGERIENNE VIE, SPA FRERES RAHMOUNE DISMAC, SPA SARPI (mêmes noms que l'appli de gestion).
- `config.raseAuto` ACTIVÉ (02:00, extinction) par migration `db.supp3` : demande du gérant.
- `extinctionDeNuit()` : si la rase a déjà été faite à la main, le PC s'éteint quand même une fois par nuit (fenêtre d'1 h après l'heure,
  pas de table ouverte, aucune activité depuis 5 min ; drapeau `db.extinctionNuit` = date). Windows + CAISSE_APP seulement.
- Gestion → Réglages : infos de mise à jour rechargées à l'affichage (après « Enregistrer », l'écran affichait à tort « hors de l'application »).

### 3.5.7 (24/11/2026, Claude) — analyse complète et corrections
- BUG GRAVE corrigé : `POST /api/pointage/autoriser` (3.5.5) avait une regex `127\\.` (double barre) → refusait tout, le pointage était impossible.
- Tables « ouvertes » (rase, rase auto, écran Caisse) = seulement celles avec des articles à payer ; les tables vides sont fermées à la rase (`fermerTablesVides`). Avant, une table ouverte puis laissée vide bloquait la rase et repoussait la rase automatique toutes les 30 min.
- Rase automatique : mail au même format que la rase normale (`mailRase` : sujet « Rase du … », sans « \n » littéraux ni [LOGO]), drapeau `raseAuto` dans `mailsAttente`, `db.extinctionNuit` posé (pas de 2e extinction). Rapport Z/Rapports : écart « à vérifier » / « à compter » au lieu de 0.
- Supplément (`supplement-fixe`) : plus de doublon « >> olives » sur les bons ; rangé dans un groupe « Suppléments » (`db.supp4`) au lieu de « Brunch œufs ».
- Connexions gardées sur disque (`data/sessions.json`) : une mise à jour ne déconnecte plus les écrans.
- Déconnexion automatique des écrans de salle : le réglage « Déconnexion automatique (secondes) » est de nouveau respecté (3.5.5 l'avait figé à 30 s).
- Rapports : tableau « Sur facture, par société » (`rapport().parSociete`). Ticket payé sur facture : « Bon pour facture », signature et cachet.
- Wafi : caissier, code 1009 (`db.equipe5`). Sauvegarde du jour nommée en date locale.

### 3.6.0 (24/11/2026, Claude) — commandes des clients par QR code (validées par Manil)
- Module `app/core/qr.js` (chargé par server.js), éteint par défaut : Gestion → Commandes QR (adresse du relais, clé secrète, horaires, pause par table, impression des QR). Détails, contrat d'API et passation : `docs/qr-commandes.md`.
- `server.js` : `verifierLignes()` + `envoyerLignes()` partagés par « Envoyer » et l'acceptation QR (même circuit de bons, mêmes règles). Ne pas recréer un second chemin d'envoi.
- Migration `db.prixSite6` : prix alignés sur le site (le site fait foi), changements notés au journal.
- Relais : Cloudflare Worker `relais/` en ligne sur https://mb-commandes.lamaisonblanche.workers.dev (compte Cloudflare de Manil). Page client : `commande/index.html` sur la branche `main`.
- Interface : bouton 📱 flottant + panneau latéral (rôle serveur et plus), son, accepter / refuser / retirer un article, addition, alerte si bons non imprimés.
- QR des 66 tables : `docs/QR-tables-La-Maison-Blanche.pdf` (jetons fixes `QR_INITIAUX`).

### 3.6.3 (24/11/2026, Claude) — clavier partout + Iced/Hot sur les lattes (demandes de Manil)
- Clavier à l'écran GLOBAL (`VKB` dans app.js, `#vkb` dans style.css) : s'ouvre seul en bas de l'écran dès qu'un champ texte, mot de passe, e-mail, téléphone ou nombre est touché (pas les champs date/heure/case à cocher ; `data-nokb` pour l'exclure). Pavé numérique pour les nombres et téléphones (bouton ABC/123), Maj, accents, OK (= Entrée + `change`), ⌄ pour fermer. Les touches ne volent pas le focus ; `input` et `change` sont envoyés comme au clavier. Si l'écran est redessiné, le champ est retrouvé par son `id`. L'ancien `clavier(id)` renvoie '' (gardé pour compatibilité).
- Migration `db.latte7` : groupe d'options obligatoire `iced-hot` (« Iced ou Hot » : Iced / Hot, 0 DA) sur tous les articles de la catégorie Lattes et tout article dont le nom contient « latte ».

### 3.6.4 (24/11/2026, Claude) — correctif saisie
- BUG corrigé : un champ en cours de saisie était vidé à chaque mise à jour automatique de l'écran (`render()` après un événement SSE, ex. synchro QR toutes les 3 s) : la clé du relais « s'effaçait ». `render()` garde maintenant le champ actif (même id ou même rang, même vue) : valeur, focus et curseur, et le `change` part en quittant le champ.
- Gestion → Commandes QR : adresse et clé du relais enregistrées dès la frappe (`oninput`), espaces retirés.
