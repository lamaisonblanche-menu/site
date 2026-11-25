# Rapport d'audit et de développement — Stocks La Maison Blanche
Claude, 25 novembre 2026 — branche `feature/gestion-stocks-magasin`

## 1. Verdict sur le prototype reçu (V0.1, ChatGPT)
Le prototype (≈ 500 lignes) posait de bonnes bases (Python sans dépendance, SQLite, rôles, PBKDF2) mais
n'était pas exploitable. Constats vérifiés en exécutant le code :

| Gravité | Constat |
|---|---|
| **Bloquant** | La confirmation de paiement plantait toujours (`POST /api/payment` : 6 colonnes, 5 valeurs → « Erreur interne »). Aucun paiement ne pouvait être enregistré ; le test fourni échouait. |
| Grave | Une demande approuvée restait « approuvée » après paiement ; pas de statut « à corriger », pas de plafond approuvé, pas de révision. |
| Grave | Sessions en mémoire : un redémarrage de SRV MB déconnectait tout le monde ; pas d'idempotence (double clic = double saisie). |
| Grave | Mouvements de stock et paiements modifiables / supprimables en base ; journal non protégé. |
| Moyen | Quantités en nombres flottants (dérives d'arrondi), pas d'unités ni de conversions, ni retours, pertes, avoirs. |
| Moyen | CUMP recalculé depuis tout l'historique à chaque affichage (lent avec le temps) ; dates en UTC avec un « +1 h » codé en dur. |
| Moyen | Doublons détectés seulement sur le n° exact (« BL-001 » ≠ « BL 1 ») ; pas d'alerte de doublon probable. |
| Moyen | Interface limitée (une ligne par bon), pas de PDF métier, pas de justificatifs, pas d'installation Windows, pas de restauration. |
| Faible | Connexions SQLite jamais fermées ; erreurs 500 non journalisées. |

Décision : **réécriture complète** en gardant l'architecture (Python + SQLite sur SRV MB, navigateur sur le poste),
qui est la bonne pour ce besoin : aucune installation lourde, fonctionnement hors Internet, une seule base sur un
seul PC, aucune dépendance avec la caisse.

## 2. Ce qui a été réalisé (v1.0.0)
- **Référentiel** : fournisseurs, articles (catégorie, emplacement, seuil d'alerte), unités de stock kg / L / unité,
  conversions automatiques g, cL, mL, et conditionnements par article (carton, sac, pack, plateau, bidon…).
- **Réceptions multi-articles** : prix, remise par ligne, total, « ce bon vaut facture », justificatifs photo/scan
  (photos compressées automatiquement), anti-doublon exact (n° normalisé) + doublon probable (même montant, ±3 jours)
  à justifier, annulation par contre-écriture (direction).
- **Sorties** vers Cuisine, Asiatique, Brunch, Comptoir/Bar autorisées par le magasinier seul, avec demandeur,
  motif, valeur au CUMP, bon de sortie imprimable avec signatures ; **retours de service, pertes/casse (motif
  obligatoire), retours fournisseur** ; sortie supérieure au stock refusée, y compris avec deux postes en même temps.
- **Factures** : rapprochement avec les bons (écart affiché), solde initial (dettes antérieures), avoirs, annulation.
- **Demandes de paiement hebdomadaires** : numérotées DP-AAAA-NNN, anciens soldes repérés, montant partiel,
  brouillon → soumise → à corriger / refusée / approuvée (plafond par facture) → partiellement payée → payée /
  clôturée ; révisions historisées ; une facture ne peut être dans deux demandes ouvertes ; PDF professionnel.
- **Paiements** : seulement par la direction, sur demande approuvée, avec date, mode, n° de chèque/virement
  obligatoire, justificatif ; partiels ; dépassement et double paiement refusés ; annulation tracée.
- **Inventaires** : comptage (option « à l'aveugle »), raison obligatoire pour chaque écart, approbation direction,
  ajustement valorisé.
- **Rapports** semaine / mois / période : achats, factures, paiements, dettes, consommation par service et par
  article, pertes, écarts, variation du stock avec **contrôle de cohérence** ; PDF et CSV (Excel français).
- **Sécurité** : comptes individuels, mots de passe PBKDF2 (310 000 itérations), mot de passe provisoire à changer,
  sessions persistantes expirantes, anti force-brute, contrôle des rôles côté serveur sur chaque action,
  contrôle d'origine (CSRF), en-têtes de sécurité, HTTPS obligatoire en réseau (autorité privée), filtrage des
  adresses du réseau local, journal d'audit **chaîné par empreintes** (toute altération est détectée).
- **Robustesse** : quantités et montants en entiers, transactions atomiques, déclencheurs d'immuabilité,
  identifiants de saisie (aucun doublon après coupure réseau), bandeau « hors connexion » et rechargement automatique.
- **Sauvegardes** : automatiques (démarrage, toutes les 6 h, 23 h 30 + tâche Windows 23 h 50), copie externe
  configurable, vérification (intégrité, empreintes, comptages), rotation 30 jours + 12 mois, restauration en un clic.
- **Installation Windows** : scripts serveur et poste, démarrage automatique (tâche SYSTEM relancée en cas de
  plantage), pare-feu limité au réseau local, raccourci bureau (Edge en mode application), désinstallation.

## 3. Résultats des tests (sur environnement de test Linux, données fictives)
`python -m unittest discover -s tests -v` → **19 tests, 19 réussis**. `tests/ui_parcours.py` → parcours complet
dans Chrome (27 captures), aucune erreur JavaScript.

| Test obligatoire | Résultat |
|---|---|
| Réception de marchandises (10 kg, sortie 3 kg → 7 kg) | ✅ |
| Réception de plusieurs articles avec conversions et remise | ✅ (montants au centime) |
| Détection d'un bon en double (exact, « BL-0042 » = « bl 42 » = « BL/042 », probable) | ✅ |
| Refus d'une sortie supérieure au stock | ✅ (API + interface) |
| Consommation des quatre services, valorisée au CUMP | ✅ (10 kg à 100 + 10 kg à 200 → 150 DA/kg vérifié) |
| Inventaires et ajustements (écart −1,5 L = −450 DA, rejet sans effet) | ✅ |
| Demandes hebdomadaires, anciens soldes, verrou, correction, refus | ✅ |
| Magasinier interdit d'approuver / payer / annuler | ✅ (403) |
| Paiements partiels 4 000 + 6 000, 6 001 refusé, double paiement refusé | ✅ |
| Exactitude des rapports (rapprochés à la base) et PDF | ✅ (PDF générés par le navigateur) |
| Deux postes simultanés (40 sorties concurrentes) | ✅ jamais de stock négatif, 14 acceptées exactement |
| Coupure réseau (renvoi de la même saisie) | ✅ aucun doublon ; bandeau et reconnexion vérifiés |
| Redémarrage brutal du serveur | ✅ sessions et données intactes, base intègre |
| Sauvegarde puis restauration | ✅ quantités, valeurs, rapports et justificatifs identiques ; archive altérée détectée |
| HTTPS / réseau | ✅ refus sans TLS, certificat vérifié, HTTP refusé, adresses hors réseau refusées |

**Pas encore fait (nécessite SRV MB et le PC magasinier) :** exécution des installateurs Windows, tests sur les
deux vrais PC, pare-feu Windows, redémarrage réel de SRV MB, génération PDF par Edge sous le compte SYSTEM.
Cette session n'avait pas d'accès au PC SRV MB ; rien n'a été installé ni publié.

## 4. Anomalies et limites restantes
1. Installateurs PowerShell **non exécutés** sur Windows : à tester sur SRV MB avant toute utilisation réelle.
2. PDF serveur via Edge lancé par le compte SYSTEM : à vérifier ; à défaut, « Imprimer › Enregistrer en PDF »
   fonctionne toujours depuis l'aperçu.
3. Si l'adresse IP de SRV MB change, le poste magasinier perd la connexion : réserver l'IP dans la box.
4. Pas encore de lien avec la caisse (consommation théorique par fiches techniques) : prévu en lecture seule plus tard.
5. Les quantités saisies acceptent 3 décimales ; les prix 2 décimales.
6. Les sorties ne sont saisies que par le magasinier (pas de demande émise par les chefs depuis un autre appareil).

## 5. Décisions à confirmer par le gérant
- Premier jour de la semaine : **dimanche** par défaut (modifiable dans Réglages).
- Achats payés comptant : passent aujourd'hui par une demande puis une confirmation direction. Faut-il un circuit
  « payé en caisse » plus court ?
- Emplacement de la copie externe des sauvegardes (clé USB, disque, NAS).
- Liste initiale des articles, unités, stocks de départ et dettes fournisseurs (solde initial).

## 6. Mon avis et améliorations proposées
- Le logiciel est maintenant **complet sur le périmètre demandé** et testé sur ses règles sensibles ; il reste la
  validation sur les vrais PC. Je recommande une semaine en parallèle du suivi actuel avant de s'y fier seul.
- Priorité suivante la plus utile : **relier les fiches techniques aux ventes de la caisse** (lecture seule du
  rapport de caisse) pour comparer chaque semaine la consommation théorique et les sorties réelles par service —
  c'est exactement le contrôle hebdomadaire du magasinier que le gérant veut faire.
- Ensuite : bon de commande fournisseur (commandé → reçu), évolution des prix d'achat par fournisseur avec alerte
  de hausse, alerte de rupture sur le téléphone du gérant, mode tablette pour les chefs (demande de sortie à valider
  par le magasinier).
