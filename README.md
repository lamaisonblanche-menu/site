# Caisse La Maison Blanche

Application de caisse Windows du restaurant La Maison Blanche (Hydra).
Cette branche ne fait pas partie du site : elle sert de canal de mises à jour à la caisse.

- `app/` : code de l'application (coquille Windows + cœur de la caisse dans `app/core/`).
- `maj/` : dernière version publiée du cœur. Les caisses du restaurant la téléchargent toutes seules
  (vérification toutes les 15 min, installation quand aucune table n'est ouverte).

Les ventes et les réglages ne quittent jamais le PC de la caisse (dossier AppData de Windows).

## Publier une modification du cœur
1. Modifier `app/core/` et augmenter `app/core/VERSION` (ex. 3.1.0 → 3.1.1).
2. `cd app && node outils/publier.js "Ce qui change"`
3. Commit + push sur la branche `caisse`.

## Refaire l'installateur Windows (seulement si la coquille change)
`cd app && npm i && npx electron-builder --win --x64 && cd outils && makensis -DVERSION=x.y.z installeur.nsi`
