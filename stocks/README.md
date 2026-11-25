# Stocks La Maison Blanche — prototype V0.1 NON DESTINÉ À LA PRODUCTION

Branche : `feature/gestion-stocks-magasin`. Aucun fichier de la caisse ou du mécanisme de mise à jour n'a été modifié.

## Réalisé
- Serveur Python standard library, SQLite transactionnel sur SRV MB.
- Comptes séparés `magasinier` / `direction`, mots de passe PBKDF2.
- Fournisseurs, articles, réceptions avec lignes, sorties vers cuisine/asiatique/brunch/comptoir, stock calculé.
- Factures, demandes de paiement, approbation/refus direction, paiements partiels confirmés exclusivement par la direction.
- Historique d'audit basique, interface française responsive, impression navigateur en PDF (pas encore de rapport PDF structuré).
- Pas de dépendance de la caisse et aucune publication.

## Lancement local de développement
Python 3.9+ requis. Depuis la racine du dépôt :
```
python stocks/server.py create-user magasinier magasinier
python stocks/server.py create-user direction direction
python stocks/server.py --host 127.0.0.1 --port 8765
```
Ouvrir http://127.0.0.1:8765. Les comptes sont créés avec mots de passe saisis de manière interactive.

## Limitations BLOQUANTES avant exploitation
- **NE PAS exposer sur le réseau du restaurant pour le moment** : serveur HTTP sans TLS, sessions en mémoire, protection anti-bruteforce et CSRF à renforcer. Installer un proxy TLS et des règles pare-feu, ou empaqueter une application Windows sécurisée.
- Prototype non testé sur les PC Windows SRV MB et magasinier ; aucun test automatisé encore exécuté.
- Interface de réception limitée à une ligne par bon (l'API accepte plusieurs lignes).
- Pas de rapprochement automatique bon de livraison/facture ; possible double comptabilisation de références si mal saisies.
- Pas de suivi des unités converties, coût moyen pondéré, inventaire physique, valorisation des sorties, retours ou pertes.
- Pas de PDF métier dédié ni pièces justificatives jointes, pas de période hebdomadaire figée.
- Demandes de paiement : validation de facture entière, pas de plafond approuvé par facture ni de révision; renforcer avant paiements réels.
- Pas de workflow de demande de sortie par chefs de service, seulement saisie validée par magasinier.
- Pas de mécanisme de sauvegarde/restauration automatisé ou de synchronisation avec la caisse.
- Authentification de toutes les routes métier réalisée ; néanmoins des tests d'autorisation et de concurrence restent nécessaires.
- **Ne pas utiliser pour enregistrer les vrais achats, stocks ou paiements du restaurant** avant validation, corrections et tests.

## Suite
1. Corriger limites de sécurité, ajouter sauvegarde et restauration testée.
2. Développer demandes de sorties, réceptions multi-lignes, rapprochement factures, inventaires, unités.
3. Verrouiller les montants approuvés, historiser les révisions et paiements.
4. Rapports hebdomadaires et PDF serveur, documents joints.
5. Tests automatisés, audit sécurité, validation fonctionnelle.
6. Déploiement sur SRV MB comme hôte central et PC magasinier comme client **après accord explicite**.
