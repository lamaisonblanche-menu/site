# Avant-premières QR

Le responsable peut activer l'offre depuis Gestion → Commandes QR. Elle est désactivée par défaut. Une portion de chaque recette est réservée au premier envoi validé par le relais pour ce plat. La caisse accepte ensuite ou refuse la commande selon son circuit habituel. Une portion déjà réclamée reste indisponible si la commande est refusée. Pour relancer un essai, créer une nouvelle campagne avec des identifiants distincts.

- Spaghettis pesto burrata · 2 300 DA.
- Linguine aux crevettes et sauce rose · 2 800 DA.

Les recettes sont définies dans le cœur de caisse et restent hors de la carte normale du QR. Il faut conserver la section Pâtes fraîches active en caisse. Le serveur distribue une portion par recette et exclut les articles d’essai des commandes classiques. Les prix sont calculés par la caisse. Le client indique qu’il a goûté puis peut rédiger un retour facultatif depuis le suivi d’une commande acceptée. Le responsable retrouve les réponses dans Gestion → Commandes QR.

## Mise en service

1. Garder la campagne désactivée et installer les versions compatibles de la caisse et de la page QR. La nouvelle page ignore l'absence du point d'accès aux essais et s'adapte à l'indication de géolocalisation du relais.
2. Déployer le relais compatible après propagation de la page. Le relais de cette branche annonce la géolocalisation prévue dans son code et la vérifie lors de l’envoi. Contrôler sur un téléphone la page et une commande habituelle.
3. Vérifier chaque recette en cuisine, puis activer l'offre quand les deux portions sont prêtes.
4. Vérifier la validation caissier, les bons cuisine, les montants et la réception du retour. En cas de problème, décocher immédiatement les avant-premières.

Vérification locale avec Node.js 22 ou ultérieur : `node --test tests-qr/essais-e2e.cjs`. Le test lance une caisse isolée, simule le stockage Durable Object et écrit les bons dans un dossier temporaire.

## Mesure des suggestions

Une suggestion est proposée au moment de la validation du panier. Le suivi pilote conserve jusqu'à 200 paniers pendant 14 jours. Il distingue les suggestions affichées, ouvertes, ajoutées et conservées par le caissier. Une relance n'augmente pas les compteurs. Une ligne retirée ou une commande refusée ne compte pas comme acceptée. Les chiffres sont regroupés par salle et article dans Gestion → Commandes QR. Ils mesurent la conversion observée, sans établir à eux seuls un gain de ventes.
