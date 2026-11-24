# Suivi des ventes La Maison Blanche

Le tableau de bord ouvre un port de consultation distinct de la caisse. Il ne propose que la lecture des rapports et leur export CSV. Les requêtes de données exigent une clé d'accès dédiée. Le compte et le code du responsable en caisse ne servent pas à cette connexion.

## Installation sur réseau privé

- Installer d'abord le paquet de caisse comportant ce module sur un poste de test. Le port de suivi est désactivé en l'absence de `suivi-srvmb.json` dans le dossier de données de la caisse.
- Dans ce dossier de données, renseigner `hote` (adresse de l'interface retenue), `port` (par exemple 8743) et `secret` (32 octets aléatoires encodés en 64 caractères hexadécimaux). Redémarrer le cœur de caisse hors service. Faire une copie locale et confidentielle de la clé pour le responsable. Pour remplacer la clé, remplacer sa valeur et redémarrer le cœur.
- Autoriser le poste SRV MB à atteindre ce seul port sur le réseau du restaurant. Le tableau de bord s'ouvre dans son navigateur.
- Pour le téléphone, utiliser un transport privé chiffré. Par exemple, avec Tailscale, limiter le téléphone et le compte autorisé au seul port de suivi, vérifier les règles existantes et garder le port de caisse hors des routes distantes. Aucune redirection du routeur vers Internet. Valider la connexion depuis la 4G et le refus d'un appareil non autorisé.
- Après activation, comparer une clôture réelle au tableau de bord et vérifier qu'un redémarrage rend le tableau de bord à nouveau joignable.

## Chiffres affichés

Le CA de synthèse provient du rapport de caisse existant. Les filtres de l'analyse agissent sur les groupes, les lignes et le CSV. Les remises de ticket sont ventilées proportionnellement et le total des lignes correspond au net du ticket. La date correspond à la journée de caisse. Une commande ouverte apparaît dans le montant à encaisser lorsqu'une journée active appartient à la période.

La marge matière couvre les lignes dont le coût par portion est connu à la date de vente. Les offerts avec coût confirmé entrent dans la marge avec un revenu nul. Les annulations sont affichées séparément à leur valeur de vente. Une option payante sans coût matière détaillé rend le coût de sa ligne inconnu. Les frais de fonctionnement et le gaspillage réel ne sont pas calculés.

## Import local des coûts

Créer un fichier `couts-matiere.json` dans le dossier de données de la caisse contenant un tableau de lignes `{ "articleId": "id-de-la-carte", "depuis": "AAAA-MM-JJ", "dinars": 0 }`. Le champ `dinars` représente le coût matière de la portion vendue, en DA, avec jusqu'à deux décimales. Conserver les anciennes dates d'effet lorsque les coûts changent. Vérifier les correspondances avec la carte réelle et le rendement de la recette avant import. Les fiches privées et les coûts réels restent dans le dossier local.

## Vérification

`node --test tests-suivi/suivi.test.js` exécute les tests du moteur et lance une caisse isolée sur des ports locaux avec des données de test.
