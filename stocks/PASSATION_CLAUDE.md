# PASSATION À CLAUDE — Gestion des stocks La Maison Blanche
Date : 25 novembre 2026
Dépôt : https://github.com/lamaisonblanche-menu/site
Branche EXCLUSIVE : `feature/gestion-stocks-magasin`
NE PAS MODIFIER `main`, `caisse`, `maj/`, `app/core/` ni publier une mise à jour de la caisse.

## Mandat
Le responsable du restaurant souhaite un logiciel de stocks **réellement exploitable**, distinct de la caisse, au design cohérent avec La Maison Blanche. Il demande à ChatGPT de développer, puis à Claude — qui dispose d'un accès au PC — de tester et d'installer seulement après validation. **Ne pas présenter le prototype actuel comme prêt.**

## Environnement cible
- SRV MB : Windows 11, utilisateur Windows `badre`, serveur central et console direction.
- PC magasinier : client sur réseau local, interface magasinier.
- Caisse principale : autre logiciel de production, à ne pas toucher.
- Données réelles, clés et mots de passe : jamais sur GitHub.
- Architecture recommandée : serveur sur SRV MB, base SQLite locale sur SRV MB (PAS de SQLite partagé sur dossier réseau), interface client navigateur ou Electron sur PC magasinier, accès réseau sécurisé et restreint au LAN.
- Le logiciel doit fonctionner sans Internet et rester simple, en français, montants DA.

## Besoin métier COMPLET
1. Référentiel fournisseurs, articles, unités, conversions (carton/boîte/unité, kg/g, L/mL), seuils d'alerte.
2. Réceptions fournisseurs : bon de livraison, facture, achats payés immédiatement, lignes multiples, prix, remises, taxes, scan/photo des justificatifs ; stock augmenté seulement à réception validée ; éviter les doublons.
3. Sorties du magasin central vers 4 services : cuisine, asiatique, brunch, comptoir/bar. Le magasinier doit autoriser toute sortie. Historiser demandeur, quantités, coût valorisé, service, date, motif, retour/perte/casse.
4. Inventaire physique, écarts, ajustement approuvé direction, journal immuable et traçabilité.
5. Rapports par semaine : achats reçus, dépenses engagées, paiements réels, dettes restantes, consommation valorisée par service, stock valorisé, alertes. **Ne pas confondre achats, sorties, ventes et paiements.**
6. Chaque semaine le magasinier prépare une **demande de paiement fournisseurs** (factures de la semaine et impayés précédents), la **soumet dans le logiciel** et **génère un PDF professionnel**. La direction approuve, refuse ou demande correction, puis **elle seule confirme le paiement réellement effectué** (date, montant, mode, référence, justificatif). Paiements partiels, reliquats, historique, double-paiement interdit. Une approbation n'est jamais un paiement.
7. Comptes individuels et autorisations serveur : magasinier / direction. Exports PDF/CSV, recherche, filtres, sauvegardes automatiques avec restauration vérifiée.
8. Identité visuelle inspirée du logiciel de caisse et de « Rapports La Maison Blanche », interface claire et rapide, sans chiffres fictifs injectés en production.

## État du code ACTUEL (important)
- `stocks/server.py` : prototype Python sans dépendances, serveur HTTP, SQLite, API JSON, comptes PBKDF2, fournisseurs, articles, réceptions, sorties, factures, demandes, approbations, paiements et audit minimal.
- `stocks/public/index.html` : interface HTML de prototype, formulaires basiques et impression navigateur.
- `stocks/backup.py` : sauvegarde SQLite manuelle avec vérification intégrité.
- `stocks/tests/test_integration.py` : tests HTTP d'intégration (créés, **pas encore exécutés sur SRV MB**).
- `stocks/README.md` : mode d'emploi prototype et limites.
- `docs/gestion-stocks-cahier-des-charges.md` : architecture et modèle de données.
- Ce code **N'EST PAS PRÊT POUR LA PRODUCTION**.

## Anomalies et manques connus à corriger en priorité
- Sécurité : HTTP sans TLS pour LAN, sessions volatiles en mémoire, pas de limitation de tentatives, pas de gestion complète des sessions, contrôle CSRF/Origin à renforcer, comptes à initialiser en sécurité, protections réseau.
- Validation : stock négatif interdit mais gestion des unités/valeurs incomplète ; les sorties ne sont pas encore valorisées en coût.
- Modèle : bons et factures non rapprochés ; pas de facture avec lignes détaillées ; pas d'avoirs ; paiements non ventilés entre factures d'une même demande ; pas de plafond de montant approuvé ; demande approuvée peut rester « approuvée » après paiement ; pas de retour « à corriger ».
- Interface : réceptions limitées à une ligne ; impression PDF générique et non un vrai document métier ; pas de pièces jointes ; pas de reporting par semaine ni d'inventaires ; pas de validation d'une demande de sortie émise par un service.
- Sauvegarde : script manuel, pas de tâche planifiée, pas de restauration ni de sauvegarde hors machine.
- Tests : écrits mais non exécutés, pas de tests Windows, réseau, concurrence, erreurs de saisie, PDF, restauration.
- Robustesse : besoin d'idempotence, de contrôle des écritures concurrentes, de tests des contraintes et de migrations de schéma versionnées.
- L'interface n'est pas une application Windows installable ; prévoir lanceur/installation adaptée aux deux postes.

## Plan de livraison attendu
A. Lire `AGENTS.md` avant toute intervention. Vérifier la branche courante, l'état du dépôt, et ne pas écraser les changements d'autres intervenants.
B. Compléter le backend avec migrations, journal immuable, stocks transactionnels, valorisation CUMP, inventaires, conversions, factures liées aux réceptions, demande/approbation/confirmation avec soldes exacts, protections anti-doublons.
C. Construire une interface magasinier et une interface direction professionnelles, avec saisie multi-lignes, filtres, justificatifs, alertes et rapports.
D. Générer les vrais PDF hebdomadaires (demande de paiement numérotée, factures incluses, totaux, statuts, signatures/validation) et rapports de consommation par service.
E. Sécuriser l'accès LAN et la gestion des comptes, sauvegardes/restauration, et packager l'application Windows. SRV MB héberge la base et le service, PC magasinier est client.
F. Exécuter tous les tests automatisés puis les scénarios manuels sur machines de test ; contrôler le pare-feu et les droits, tester déconnexion/redémarrage/restauration, vérifier l'absence de modification POS.
G. Remettre un rapport détaillé : fonctions terminées, résultats des tests, anomalies restantes, instructions d'installation, procédure de rollback. **Demander accord explicite avant de déployer sur SRV MB et PC magasinier ou d'utiliser des données réelles.**

## Tests d'acceptation indispensables
- Réception 10 kg, sortie 3 kg cuisine => stock 7 kg ; sortie 8 kg refusée.
- Même bon fournisseur saisi deux fois => refus/alerte sans double stock.
- Facture 10 000 DA, demande 10 000 DA soumise par magasinier ; magasinier ne peut ni approuver ni payer.
- Direction approuve mais dette reste 10 000 DA ; direction confirme 4 000 DA => dette 6 000 DA ; puis 6 000 DA => dette 0 ; paiement supplémentaire refusé.
- Facture ancienne impayée apparaît dans la nouvelle semaine sans être recréée.
- Demande rejetée ou à corriger n'est pas payable sans nouvelle approbation.
- Rapport hebdomadaire sépare achats, consommation par service, dettes, décaissements ; totaux rapprochés à la base.
- PDF exportable/imprimable, justificatifs accessibles, archivage des versions.
- Sauvegarde puis restauration sur base de test => montants et quantités identiques.
- Deux postes simultanés, panne réseau, redémarrage SRV MB, reconnexion, aucun doublon.
- Jamais de modification à `caisse`, `main`, `maj/` ou données POS.

## Lancement prototype local (PAS installation production)
```powershell
py stocks/server.py create-user magasinier magasinier
py stocks/server.py create-user direction direction
py stocks/server.py --host 127.0.0.1 --port 8765
py -m unittest discover -s stocks/tests -v
```
ATTENTION : ne pas ouvrir le serveur sur 0.0.0.0 sans sécurisation préalable. Ne pas employer des données réelles pour les tests.

## Consigne finale
Le responsable attend un logiciel complet, fiable et beau, pas un tableau de bord fictif. Poursuivre le travail de développement sur la branche dédiée, signaler les blocages réels, ne pas prétendre que les tests ou l'installation ont été effectués avant preuve. Les machines Windows sont accessibles à Claude, pas à ChatGPT.

## MISE À JOUR 25/11/2026 15h30 (Claude)
Le prototype a été réécrit (v1.0.0). État, tests et anomalies restantes : `stocks/RAPPORT_AUDIT_CLAUDE.md`. Mode d emploi : `stocks/README.md`. Tests : `cd stocks && python -m unittest discover -s tests -v` (19/19 OK). Non installé sur SRV MB, en attente de l accord du gérant.


## Mise à jour à distance (v1.2.0, 25/11/2026)
- Réglages › « Mettre à jour maintenant » (direction) : `POST /api/mise-a-jour` → `majlogiciel.lancer()` télécharge le zip de la branche, vérifie (compile des .py), copie dans `C:\MBStocks\app` sauf `data/tests/__pycache__`, puis le serveur se redémarre seul (surveillance des .py dans `server.py`).
- `GET /api/mise-a-jour?verifier=1` compare `VERSION` local et GitHub ; vérification automatique chaque nuit à 4 h (`boucle_auto`).
- Il suffit donc de pousser sur `feature/gestion-stocks-magasin` et d'incrémenter `stocks/VERSION` : plus besoin d'aller sur SRV MB.
- Poste magasinier installé le 25/11 (certificat MB, raccourci Edge sur https://192.168.100.29:8765, hosts SRV-MB → IPv4 ; scripts sur la clé USB `E:\Stocks-PC-magasinier`).

## v1.3.0 (25/11/2026)
- `catalogue_initial.json` : 276 articles de départ (sans quantité) tirés de la carte, importés **une seule fois** au démarrage du serveur (`M.import_catalogue`, drapeau `settings.catalogue_initial_v1`) ; les articles existants ne sont jamais modifiés. Désactivable par `MB_STOCKS_NO_CATALOGUE=1` (tests).
- Saisie d'un bon de réception : si l'article tapé n'existe pas, bouton « ＋ Créer l'article « … » » qui ouvre la fiche pré-remplie puis met l'article sur la ligne (Wi-Fi nécessaire). Créer une fiche n'ajoute aucune quantité : seul le bon validé fait entrer le stock.

## 1.4.0 (25/11/2026, Claude) — fournisseurs + achats divers (demande de Manil)
- `M.import_fournisseurs` (au démarrage, une seule fois, clé `fournisseurs_initiaux_v1`) : 18 fournisseurs habituels (liste des achats du restaurant, dont « Divers » et « Divers matériel »). Ceux qui existent déjà ne sont pas touchés.
- Migration SQL V2 : `receipts.divers` + table `receipt_misc_lines` (désignation, montant, immuable). Case « Achat divers » sur le bon : lignes libres sans article ni mouvement de stock ; compté dans les achats, factures et demandes de paiement comme un bon normal. Choisir un fournisseur dont le nom commence par « Divers » coche la case tout seul.

## v1.5.0 (25/11/2026) — version téléphone
- Interface adaptée au téléphone (≤ 820 px) : menu latéral escamotable (bouton ☰), grilles et formulaires sur une colonne, fenêtres en plein écran, lignes des bons en cartes, tableaux défilables, champs en 16 px (pas de zoom iOS), méta « écran d'accueil » iOS.
- Accès à distance : Tailscale sur SRV MB (compte maisonblanchehydra@gmail.com), `tailscale serve --bg https+insecure://localhost:8765` → https://srv-mb.tailf1bd67.ts.net (les requêtes arrivent de 127.0.0.1, donc acceptées).
- v1.5.1 : bouton « Entrer comme magasinier (sans mot de passe) » sur l'écran de connexion, à la demande de la direction (`magasinier_direct` dans `/api/connexion`). Refusé depuis l'accès Tailscale (en-tête `Tailscale-User-Login`, bouton masqué sur *.ts.net) et hors réseaux autorisés ; journalisé `connexion_sans_mdp`. La direction garde son mot de passe.
- v1.5.2 : depuis l'installation de Tailscale, « srv-mb » se résout en 100.x (MagicDNS) → « Poste non autorisé ». Les plages Tailscale (100.64.0.0/10, fd7a:115c:a1e0::/48) sont acceptées ; l'entrée magasinier sans mot de passe y reste refusée.

## v1.6.0 (25/11/2026) — prévention des pannes (`controle.py`)
- **Essai avant installation** : toute nouvelle version (bouton, mise à jour de nuit, ou fichiers déposés dans `C:\MBStocks\app`) est d'abord essayée dans un processus à part : compilation, import de tous les modules, migrations sur une **copie** de la base. Refusée → rien n'est changé (`MISE À JOUR REFUSÉE` dans le journal, bandeau sur le tableau de bord de la direction) et les fichiers de la version qui tourne sont remis (`data/versions/code-<version>.zip`, 5 dernières gardées).
- Le serveur attend la fin de la copie (aucun changement pendant 6 s) avant de redémarrer ; sauvegarde `avant-maj` avant chaque redémarrage de mise à jour.
- Secours : déposer un fichier vide `FORCER_MAJ` dans le dossier de l'appli fait passer la version sans essai (une fois).
- **Contrôle de santé** (`GET /api/sante`, direction ; aussi 2 min après démarrage puis toutes les 6 h dans le journal) : intégrité de la base, journal chaîné, stock = dernier mouvement, clés étrangères, disque, âge de la dernière sauvegarde.
- **Erreurs d'écran** : toute erreur JavaScript sur un poste/téléphone est envoyée à `POST /api/erreur-client` et notée dans le journal (`ERREUR écran`), 30/h max.
- Limite d'essais de connexion comptée par appareil d'origine derrière Tailscale (`X-Forwarded-For`).

## v1.7.0 (26/11/2026) — annulations par le magasinier (demande de Manil)
- Le magasinier peut annuler un **bon** validé (contre-écriture du stock) et une **facture** (motif obligatoire, tracé au journal), comme la direction.
- Facture dans une demande en brouillon / à corriger : retirée automatiquement de la demande (demande vide → annulée). Dans une demande soumise ou approuvée : il faut d'abord annuler la demande.
- Nouvelle route `POST /api/demande/annuler` (`cancel_request`) : magasinier ou direction, demande brouillon, soumise, à corriger, refusée ou approuvée, **tant qu'aucun paiement non annulé n'existe** sur la demande. Bloqué dès que la direction a confirmé un paiement (`deja_payee`).
- Pas de changement de base : une demande annulée = statut `cloturee` + commentaire préfixé « Annulée : » (`ANNULEE`), drapeaux `annulee` / `can_cancel` dans le détail ; l'interface affiche « Annulée ».
- Test : `T2Paiements.test_00_annulations_magasinier`.
