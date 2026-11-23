# Rapport avant publication — La Maison Blanche
Date : 23 novembre 2026
Branche de travail : `audit-securite-caisse-20261123`
Branche de destination : `caisse` (jamais `main`)
Version actuellement publiée : **3.5.3**
Statut : **NON PUBLIABLE — VALIDATION INCOMPLÈTE**

## Réalisé dans la pull request #3
- Limitation des tentatives incorrectes de connexion, validation de code et pointage : cinq échecs sur cinq minutes puis blocage temporaire.
- Expiration des sessions après deux heures d'inactivité ou douze heures au maximum ; contrôle également sur les exports.
- Protection contre l'interprétation de champs libres comme formules dans les CSV.
- Contrôle des quantités envoyées en cuisine (entiers de 1 à 99), des doublons et indices invalides d'options.
- Contrôle des montants de paiement négatifs/non entiers et des dates/heures de réservation.
- Synchronisation explicite du fichier de données sur disque et sauvegarde du ticket avant de déclencher son impression.
- Tests ciblés ajoutés (`app/tests/caisse.test.js`) et workflow de vérification de syntaxe proposé.

## Contrôles effectués
- Lecture du serveur, de l'interface et des consignes `AGENTS.md`.
- Vérification de syntaxe du serveur par moteur JavaScript sur plusieurs versions intermédiaires.
- Exécution isolée d'un test de protection CSV.
- Inspection du code de la version en branche et correction d'une expression régulière erronée.

## Non validé / risques résiduels
1. **Encaissement** : aucune clé d'idempotence durable n'est encore mise en œuvre pour protéger tous les cas de renvoi de requête, notamment les paiements partiels.
2. **Impression** : aucun test physique Windows/USB/TCP ; absence de confirmation matérielle certaine de sortie du ticket.
3. **Sauvegarde** : pas de restauration vérifiée sur copie ; les copies restent sur le même support par défaut.
4. **Réservations** : connexion Gmail IMAP et import réel non testés ; vérification des mails à effectuer.
5. **Sécurité réseau** : accès HTTP sur le réseau local ; isoler les terminaux de caisse du Wi-Fi public.
6. **Interface** : aucun test navigateur 1024×768 de commande complète et de supplément.
7. **Rapports** : tableaux de bord complémentaires et rapprochement chèques/sociétés non développés.
8. **Automatisation** : aucun résultat de workflow GitHub Actions confirmé.
9. **Publication** : version du cœur et dossier `maj/` non mis à jour ; ne pas fusionner.

## Scénarios obligatoires avant publication
- Démarrer sur une copie isolée des données, jamais sur la caisse en service.
- `node --check app/core/server.js` et `node --check app/core/public/app.js`.
- `node --test app/tests/*.test.js`.
- Ouvrir une table, commander plusieurs plats, ajouter Frites +500 DA, envoyer vers chaque poste et contrôler les bons simulés.
- Encaisser en espèces, TPE, mixte, partiellement, avec remise et offert ; vérifier total, ticket, journal et rase.
- Réessayer une requête d'encaissement après réponse perdue et vérifier qu'aucun ticket n'est dupliqué.
- Débrancher/rebrancher une imprimante ; contrôler erreur, réimpression et absence de perte.
- Simuler arrêt brutal puis redémarrage, vérifier tickets et restaurer une sauvegarde dans une installation distincte.
- Tester réservation téléphone, réservation site Gmail et conflits de tables.
- Tester sur Windows et imprimantes réelles au restaurant après validation du patron.

## Décision
**NE PAS PUBLIER.** Préparer une version supérieure à 3.5.3, régénérer `maj/` avec `app/outils/publier.js`, vérifier les hashes et effectuer les tests ci-dessus. Obtenir l'accord explicite du patron avant fusion de la PR vers `caisse`.
