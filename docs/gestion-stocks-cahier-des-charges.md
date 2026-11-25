# Gestion des stocks — cahier des charges technique V1

Date : 25 novembre 2026
Branche de préparation : `feature/gestion-stocks-magasin` basée sur `caisse` (VERSION 3.7.8 au moment de la lecture).
Statut : conception, non installée, non publiée.

## Objectif
Application distincte de la caisse La Maison Blanche, même identité visuelle, interface en français, montants en DA. Deux postes : PC magasinier pour les opérations quotidiennes et SRV MB pour la direction. Aucun changement au cœur POS ni au système de mises à jour `maj/`.

## Architecture recommandée
- Service central sur le PC magasinier **ou** sur un hôte dédié toujours allumé (choix à confirmer selon disponibilité des machines) ; base de données centrale transactionnelle SQLite, mode WAL et sauvegardes vérifiées. SRV MB y accède par LAN avec authentification, HTTPS ou canal réseau sécurisé. Ne pas partager directement le fichier SQLite sur un lecteur réseau.
- Interface locale/desktop sur chaque poste, mêmes composants graphiques que « Rapports La Maison Blanche », rôles distincts. Alternative : service central sur SRV MB si machine allumée en permanence, magasinier client. Déterminer l'hôte avant déploiement.
- Réseau indisponible : lecture du dernier état éventuellement possible, mais aucune écriture locale concurrente silencieuse ; afficher clairement « hors connexion ».
- Intégration POS future en lecture seule pour ventes / coût matières, après référentiel de recettes ; ne jamais écrire dans `caisse.json` ni mélanger les comptes d'accès.
- Secrets, sauvegardes et données réelles exclus de GitHub.

## Rôles
**Magasinier** : gérer articles, unités, fournisseurs, réceptions, pièces justificatives, demandes de sorties, validation de délivrance, inventaires proposés, préparation et soumission de demandes de paiement, export PDF. Ne peut pas approuver ses propres demandes, confirmer les paiements ou supprimer les écritures historiques.
**Direction** : voir tous les mouvements et indicateurs, approuver/rejeter/renvoyer les demandes, confirmer les paiements réels (y compris partiels), autoriser ajustements d'inventaire et corrections tracées.
Toutes les actions sensibles enregistrent utilisateur, horodatage, référence et motif.

## Modules et règles métier
### Achats / réceptions
- Fournisseur, numéro de bon/facture, date du document, date de réception, articles, quantités, unité, prix unitaire, remise/taxes éventuelles, montant, échéance, statut payé/impayé, scan/photo justificatif.
- Distinguer réception de stock, facture et paiement : un bon de livraison n'est pas nécessairement une facture ; prévenir la double comptabilisation.
- Anti-doublons : fournisseur + type + numéro de pièce, avec alerte et justification d'exception.
- Unités et conversions : kg/g, L/mL, unité/carton, unités d'achat vs unités de sortie ; conversion contrôlée par article.
- Valorisation V1 recommandée : coût moyen pondéré mobile, à valider avec direction/comptable ; gérer retours et avoirs séparément.

### Sorties services
- Quatre destinations : cuisine, asiatique, brunch, comptoir/bar.
- Bon de sortie : service, article, quantité, unité, date, demandeur, magasinier validateur, motif, signature/validation.
- Aucune sortie n'affecte le stock avant validation magasinier ; refuser stock négatif sauf dérogation direction documentée.
- Sorties interservices, retours magasin, casse/pertes et corrections en opérations distinctes.
- Rapports hebdomadaires quantités et coûts par service ; distinguer consommation sortie du magasin et consommation théorique liée aux ventes.

### Fournisseurs / demandes hebdomadaires
- Regrouper factures échues ou sélectionnées, y compris soldes antérieurs, sans dupliquer la dette.
- Brouillon -> soumise -> à corriger / rejetée / approuvée -> partiellement payée / payée.
- Magasinier soumet et génère PDF numéroté avec période, fournisseurs, pièces, total dû, montant demandé, ancien solde, justificatifs, statut et date.
- Direction seule approuve/refuse et confirme un règlement effectif : date, mode, montant, référence, justificatif.
- Approbation ≠ paiement ; paiements partiels et plusieurs paiements par facture ; le solde reste dû jusqu'au paiement réel.
- Verrouiller le contenu approuvé ; correction = nouvelle révision avec traçabilité.
- Ne pas permettre la sélection d'une même somme dans deux demandes ouvertes sans alerte ou blocage.

### Inventaires / rapports
- Inventaire physique par article et emplacement, écarts théorique/réel, justification, approbation direction avant ajustement.
- Achats reçus, dépenses engagées, décaissements réels, dettes fournisseurs et consommations par service : quatre indicateurs distincts.
- Filtres par semaine ISO, mois, service, fournisseur, article ; exports PDF/CSV.
- Rapport hebdomadaire direction : achats, sorties, variation stock, factures à payer, paiements, restes dus, alertes de rupture et écarts.

## Modèle de données initial
`users`, `suppliers`, `items`, `units`, `unit_conversions`, `receipts`, `receipt_lines`, `supplier_invoices`, `invoice_lines`, `stock_movements`, `service_issue_requests`, `service_issue_lines`, `payment_requests`, `payment_request_lines`, `payment_request_revisions`, `payments`, `payment_allocations`, `inventory_counts`, `inventory_count_lines`, `attachments`, `audit_log`.
- Identifiants immuables, contraintes d'unicité, montants en entiers DA, quantités en unités normalisées, transactions atomiques.
- Stock calculé depuis le journal immuable des mouvements ; cache de solde possible avec réconciliation.
- Toutes les pièces jointes sauvegardées avec contrôle de taille/type et sauvegarde coordonnée avec la base.

## Interface
- Tableau de bord direction avec achats, sorties, stock valorisé, demandes en attente, dettes et paiements.
- Magasinier : navigation Achats / Sorties / Fournisseurs / Paiements à demander / Inventaires / Rapports.
- Direction : demandes à valider, paiements à confirmer, historique, stocks et écarts.
- Recherche rapide article/fournisseur, formulaires clavier, export PDF lisible et imprimable, design cohérent avec la caisse.
- Saisie manuelle des bons indispensable ; photos/scans et OCR éventuel en option après validation du besoin, jamais de validation automatique de montants OCR.

## Sécurité / disponibilité
- Authentification individuelle, mots de passe hachés, sessions expirantes, contrôle des rôles côté serveur, audit non modifiable depuis l'interface.
- Base centralisée sur un seul hôte, sauvegarde quotidienne automatique + copie hors machine, restauration testée.
- Pas d'accès direct Internet par défaut ; réseau local seulement, accès distant ultérieur via VPN.
- Toute correction se fait par contre-écriture ou ajustement approuvé, pas par suppression d'un mouvement.
- Double soumission et double clic protégés par identifiants idempotents.

## Phases de réalisation
1. Confirmer hôte central, accès réseau, politique des comptes et modalités de saisie des justificatifs.
2. Créer application autonome sous un dossier distinct `stocks/` dans cette branche (ou dépôt dédié), sans toucher `app/core/` ni `maj/`.
3. Implémenter base/migrations, API, authentification, rôles et journal.
4. Implémenter achats/réceptions, sorties, inventaires, dettes fournisseurs.
5. Implémenter workflow demandes hebdomadaires, approbation, confirmation de paiements et PDF.
6. Développer interfaces magasinier et direction, puis rapports.
7. Tests automatisés : quantités, conversions, concurrence, doublons, soldes, partiels, droits, déconnexion, redémarrage, restauration, PDF.
8. Tests sur les deux PC du restaurant, sauvegarde et validation explicite avant installation.

## Décisions restant à confirmer
- Quelle machine restera allumée pour héberger le serveur central (SRV MB, PC magasinier ou serveur dédié) ?
- Les bons seront-ils saisis manuellement avec photo/scan joint, ou une lecture automatique est-elle souhaitée ?
- Quelle date de début/fin de semaine et quel traitement pour les achats payés immédiatement ?
- Qui peut demander une sortie de matière et sur quel appareil (magasinier seul ou chefs de service aussi) ?
- Inventaire initial : liste d'articles, unités, stocks de départ, fournisseurs, soldes de factures.

## Limites actuelles
Document de conception uniquement. Aucune application créée, aucun test exécuté, aucune installation ou publication effectuée.
