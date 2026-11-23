# Module commandes QR — plan technique (brouillon, non déployé)

Date : 2026-11-24. Base : branche `caisse`, version 3.5.7.
Décisions : QR permanent par table ; menu actuel du site ; commande soumise au caissier avant impression ; paiement uniquement à la caisse.

## Architecture
- Site public (branche `main`) : parcours mobile, panier, choix de la table via QR, validation du panier, suivi du statut. Le site public ne parle jamais directement à `localhost:8080` ou au LAN.
- Service relais HTTPS distinct (hébergement à déterminer) : API de dépôt, stockage durable, identifiant unique de soumission, protection anti-abus, états et accusés de réception. Authentification machine à machine pour la caisse ; aucune clé secrète dans le navigateur.
- Caisse principale (branche `caisse`) : agent de synchronisation sortante, récupération de commandes entrantes, stockage local durable, interface d'approbation caissier, intégration au circuit d'envoi/impression. L'agent doit survivre aux redémarrages et ne pas bloquer la caisse hors connexion.
- Référentiel des produits : correspondance stable entre identifiants du site et `db.produits[].id`. Les prix, disponibilités, options et cuissons sont revalidés côté caisse ; jamais confiance dans les prix envoyés par le navigateur.

## Constat vérifié dans app/core/server.js
- `POST /api/commande/ouvrir` (vers ligne 1236) ouvre/retrouve une commande pour salle/table ; réservé aux utilisateurs connectés.
- `POST /api/commande/envoyer` (vers ligne 1265) valide quantités/options/stock, ajoute les lignes, crée les bons KDS, appelle `imprimer()` pour chaque poste ; ce n'est pas une route adaptée à une commande QR non approuvée.
- `postesDe(pid)` (vers ligne 556) gère les imprimantes multiples et `partout`.
- `imprimer()` (vers ligne 520) gère USB Windows, TCP/9100 et simulation.
- `save()` (vers ligne 368) diffère la sauvegarde de 150 ms ; pour les transitions QR critiques, une persistance durable avant accusé est à concevoir.
- `/api/events` (vers ligne 1865) diffuse les événements SSE sur le réseau local ; l'authentification et le périmètre des données SSE doivent être revus avant toute exposition.
- Le serveur écoute sur `0.0.0.0` port 8080 : ne pas ouvrir ce port sur Internet.
- Les modifications du cœur se diffusent par `maj/` : NE PAS générer `maj/`, augmenter VERSION, fusionner ou publier durant ce travail de préparation.

## États et contrats proposés
- `qrInbox[]` : `id`, `submissionId`, `salle`, `table`, `items`, `note`, `createdAt`, `status`, `decisionBy`, `linkedCommandeId`, `error`.
- États : `received` -> `pending_cashier` -> `accepted` ou `rejected` ; `accepted` -> `dispatching` -> `dispatched` ou `print_attention`.
- Identifiant idempotent global : une même `submissionId` ne peut jamais ajouter deux fois les articles.
- Le caissier peut refuser, vérifier/modifier la commande et approuver ; seul ce geste déclenche l'intégration à la table et les bons.
- L'impression doit avoir un identifiant de job par commande/poste et un statut durable. Après interruption ambiguë, ne pas réimprimer automatiquement sans contrôle humain : risque de doublons physiques.
- Un QR permanent permet toujours de voir le menu. Les commandes restent filtrées par caissier, anti-spam et statut de table ; aucun contrôle de présence absolu n'est garanti. Prévoir une mise en pause d'une table et une alerte si table non ouverte.
- Toute commande en attente doit être visible après redémarrage ; ne pas bloquer les commandes classiques si relais Internet indisponible.

## Travaux par lots
1. Audit des routes, modèle de données, impression, sécurité, interface et site `main`. Vérifier le déploiement du site et les capacités de l'hébergeur.
2. Spécification du relais HTTPS, contrat API et catalogue produit. Déterminer l'hébergement et les secrets.
3. Développer les commandes QR entrantes dans `app/core/server.js`, migration additive et tests unitaires.
4. Ajouter interface de validation caissier dans `app/core/public/app.js` et style associé.
5. Adapter le site public par une PR distincte ciblant `main`, sans fusionner les deux branches.
6. Tests hors production : quantités, cuissons obligatoires, suppléments, ruptures, tables fermées, refus, concurrence, pertes de réseau, redémarrage, idempotence, bons multi-postes, USB et TCP, paiement et rase.
7. Publication seulement après approbation explicite, test réel sur une table et sauvegarde des données.

## Risques ouverts
- Les commandes actuelles modifient l'état puis déclenchent les impressions ; reprise après crash et idempotence nécessitent un protocole dédié.
- Un retour TCP OK ne garantit pas le papier imprimé ; prévoir un état d'impression à vérifier.
- Le catalogue du site public peut diverger de la caisse.
- Le fonctionnement hors Internet de la caisse doit être préservé.
- QR toujours actif : risque de commandes hors restaurant, mitigé par validation caissier et anti-abus, non éliminé.

## Périmètre de cette branche
Document de conception seulement. Aucun changement de code opérationnel, aucune mise à jour du cœur ou de `maj/`, aucune publication.
