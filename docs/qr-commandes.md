# Commandes QR — contrat technique et passation

Branche : `claude/qr-commandes` (partie de `caisse` 3.5.7). **Rien n'est publié** : pas de `maj/`, pas de VERSION augmentée, pas de fusion sans l'accord de Manil.
Ce document sert aussi de **passation** : si Claude s'arrête (limite d'utilisation), ChatGPT/Codex reprend ici.

## Décisions de Manil (24/11/2026)
- Le client commande seul : la table s'ouvre toute seule à l'acceptation, aucun serveur n'a besoin de l'ouvrir avant.
- Validation obligatoire par un **serveur, le maître d'hôtel ou un caissier**, avec un panneau discret qui ne prend pas tout l'écran.
- Pas d'écran en cuisine : les **bons imprimés** (cuisine, asiatique, comptoir) restent le seul moyen d'informer la cuisine.
- Paiement à la caisse. Demande d'addition depuis le téléphone = notification à la caisse (pas de bouton « appeler le serveur »).
- Toute la carte, **en français uniquement**, photos du site, suggestions (dessert, boisson) après l'ajout d'un plat.
- Les 3 espaces (Gastro, Brunch, Terrasse), toutes les tables.
- Prix : **le site fait foi**. Migration `db.prixSite6` (server.js) aligne les prix de la caisse sur le site, par nom d'article.
- Hébergement du relais : Cloudflare (compte gratuit, accord de Manil).

## Architecture
```
Téléphone (4G, pas de Wi-Fi au restaurant)
  └─ https://lamaisonblanchehydra.com/commande/?t=JETON   (page statique, branche main, PR séparée)
        └─ fetch → RELAIS Cloudflare Worker + Durable Object (relais/)
                    ↑  POST /caisse/sync toutes les 3 s (connexion SORTANTE, clé secrète)
              Caisse principale (app/core/qr.js)
```
- Le port 8080 de la caisse n'est jamais exposé. Aucun secret dans le navigateur.
- Prix, options, cuissons, ruptures : recalculés par la caisse (`verifierLignes`) ; le téléphone n'envoie que `pid`, `qte`, `opts` (indices), `note`.
- Le relais refuse les nouvelles commandes si la caisse n'a pas appelé depuis 120 s (PC éteint, coupure) : le client voit « commande en ligne indisponible ».

## Côté caisse (fait)
- `server.js` : `verifierLignes(c, lignes)` (contrôle sans rien modifier) et `envoyerLignes(c, lignes, u, opt)` (ajout + bons + impression), utilisés par `POST /api/commande/envoyer` ET par l'acceptation QR. Même circuit d'impression, mêmes règles (supplément, suites, bons communs, `partout`, `postes`).
- `qr.js` (module chargé par server.js) :
  - `db.qrTables` { jeton: {salle, table, retire} } : 66 jetons fixés dans `QR_INITIAUX`, nouveaux jetons aléatoires pour les nouvelles tables.
  - `db.qrInbox[]` : {id (relais), sid, type commande|addition, jeton, salle, table, lignes, note, recu, statut attente|traitement|acceptee|refusee|vue, ack, statutOk, alertes, detail, montant, decision, cmdId, echecs}.
  - `db.config.qr` : {actif (false par défaut), relais, secret, montantMax 40000, ouverture 09:00, ouvertureVendredi 16:00, derniereCommande 22:45, horaires {Brunch 09:00–18:00, Asiatique 11:00–22:45}, pauses {jeton: ts}, son}.
  - Routes : `POST /api/qr/accepter {id, retirer?:[index], pin?}`, `POST /api/qr/refuser {id, motif}`, `POST /api/qr/vu-impression {id}`, `POST /api/qr/pause {jeton|salle,table, pause}`, `GET /api/qr/admin`, `POST /api/qr/reglages`, `POST /api/qr/imprimer {salle?, table?}` (QR sur l'imprimante des tickets).
  - `etatPublic().qr` pour les écrans (rôle serveur et plus).
- Exactement une fois : la commande est écrite sur le disque (`saveNow`) avant l'accusé ; l'id du relais est unique ; l'acceptation passe `attente → traitement → acceptee` sans `await` entre le contrôle et l'écriture.

## Contrat du relais
### Caisse → relais : `POST /caisse/sync` (en-tête `Authorization: Bearer <secret>`)
Corps : `{ version, heure, service:{ouvert, univers:{Brunch:bool,…}, message}, tables:[{jeton, salle, salleNom, table, pause}], acks:[id], statuts:[{id, statut, motif, retirees, total}], carteHash, carte? }`
Réponse : `{ commandes:[{id, sid, type, jeton, lignes, note, appareil, client, ts}], acksOk:[id], statutsOk:[id] }`
- Le relais renvoie toutes les commandes non accusées. Après `acks`, il ne les renvoie plus.
### Téléphone → relais (public, CORS limité à lamaisonblanchehydra.com)
- `GET /api/table?t=JETON` → `{ salleNom, table, pause, service, caisseEnLigne }`
- `GET /api/carte` → la dernière carte envoyée par la caisse
- `POST /api/commande` `{ t, sid (uuid), type:'commande'|'addition', lignes:[{pid,qte,opts:[{g,i}],note}], note, appareil, client }` → `{ id, statut }` (même `sid` = même réponse, jamais de doublon)
- `GET /api/commande?id=…&a=APPAREIL` → `{ statut, motif, retirees, total }`
- Limites : 1 commande / 20 s et 6 / 10 min par table, 10 / 10 min par adresse IP, 40 lignes, 20 par article, montant estimé ≤ montantMax, table en pause refusée.

## État au 24/11 01:30 (Claude)
Fait et testé (rien de publié) :
- Caisse : `qr.js`, envoi commun, migration prix, panneau 📱 (bouton flottant + panneau latéral), onglet Gestion → Commandes QR (activation, relais, clé, horaires, pause par table, impression des QR, historique). Envoi direct en cuisine par défaut (`config.qr.suites = 'direct'`).
- Relais : `relais/worker.js` + `relais/wrangler.toml` (Worker + Durable Object SQLite). Testé avec `wrangler dev`.
- Page client : branche `claude/qr-page-commande` (base `main`), fichier `commande/index.html`. Constante `RELAIS` à remplacer par l'adresse réelle du Worker.
- QR des 66 tables : `docs/QR-tables-La-Maison-Blanche.pdf` (jetons = `QR_INITIAUX` de qr.js).
- Tests : `tests-qr/qr-e2e.js` (faux relais, 24 contrôles) et `tests-qr/relais-e2e.js` (vrai relais local, 15 contrôles), tous OK.

## Mise en ligne (seulement avec l'accord de Manil)
1. Relais : `cd relais && npx wrangler login` (ou `CLOUDFLARE_API_TOKEN`), `npx wrangler deploy`, puis `npx wrangler secret put CAISSE_SECRET` (longue clé aléatoire). Noter l'adresse `https://mb-commandes.<compte>.workers.dev`.
2. Page : remplacer `RELAIS` dans `commande/index.html` (branche `claude/qr-page-commande`), PR vers `main`, fusion par Manil.
3. Caisse : VERSION 3.6.0, `cd app && node outils/publier.js "Commandes QR des clients (désactivées tant que le relais n'est pas réglé) et prix alignés sur le site"`, PR vers `caisse`, fusion par Manil.
4. Au restaurant : Gestion → Commandes QR : adresse du relais + clé, cocher « Accepter les commandes », Enregistrer. Vérifier 🟢.
5. Test réel sur une table, puis imprimer et poser les QR.

## Reste à faire / idées
- Plan de salle : faire clignoter la table qui a une commande QR en attente.
- Réimpression ciblée des seuls bons en échec (aujourd'hui « Réimprimer les bons » réimprime toute la table).
- Turnstile (anti-robots Cloudflare) sur la page si des abus apparaissent.

## Journal
- 24/11 01:20 (Claude) : refactor envoi, migration prix, qr.js, ce document.
- 24/11 01:30 (Claude) : interface caisse, relais, page client, PDF des QR, tests.
