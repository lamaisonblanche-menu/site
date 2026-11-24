import argparse
import json
import re
from datetime import datetime
from pathlib import Path

import pdfplumber

COLONNES = dict(zip(
    'Ent Det Reg Esp Chq Tpe Deb Off Aut Diff'.split(),
    [299, 361.4, 423.7, 486.1, 542.8, 599.5, 656.2, 712.9, 769.5, 823.4],
))
REGLEMENTS = 'Esp Chq Tpe Deb Off Aut'.split()


def montants(mots):
    values = dict.fromkeys(COLONNES, 0)
    vus = set()
    for mot in mots:
        valeur = mot['text']
        if not re.fullmatch(r'-?[\d.]+,\d{2}', valeur):
            continue
        colonne = min(COLONNES, key=lambda c: abs(mot['x1'] - COLONNES[c]))
        if abs(mot['x1'] - COLONNES[colonne]) > 8 or colonne in vus:
            raise ValueError('Colonne de montant ambiguë')
        vus.add(colonne)
        values[colonne] = int(valeur.replace('.', '').replace(',', ''))
    if 'Reg' not in vus:
        raise ValueError('Recettes manquantes')
    return values


def lire(pdf):
    lignes, total = [], None
    with pdfplumber.open(pdf) as document:
        for page in document.pages:
            groupes = []
            for mot in sorted(page.extract_words(), key=lambda m: m['top']):
                if not groupes or mot['top'] - groupes[-1][0]['top'] > 2:
                    groupes.append([])
                groupes[-1].append(mot)
            for groupe in groupes:
                mots = sorted(groupe, key=lambda m: m['x0'])
                texte = ' '.join(m['text'] for m in mots)
                date = next((m for m in mots if re.fullmatch(r'\d{2}/\d{2}/\d{4}', m['text'])), None)
                caisse = re.match(r'^\d+\s*-\s*(.+?\bC[1-4])\b', texte)
                if 'TOTAL GÉNÉRAL' in texte.upper():
                    if total is not None:
                        raise ValueError('Total général en double')
                    total = montants(mots)
                if date and caisse:
                    valeurs = montants(m for m in mots if m['x0'] > date['x1'])
                    if valeurs['Reg'] != sum(valeurs[c] for c in REGLEMENTS):
                        raise ValueError('Écart entre recettes et règlements')
                    lignes.append({'date': datetime.strptime(date['text'], '%d/%m/%Y').date().isoformat(),
                                   'caisse': caisse[1], **valeurs})
    calcule = {c: sum(ligne[c] for ligne in lignes) for c in COLONNES}
    if not lignes or total != calcule:
        raise ValueError(f'Total incohérent : {len(lignes)} lignes, {calcule}, attendu {total}')
    if len({(l['date'], l['caisse']) for l in lignes}) != len(lignes):
        raise ValueError('Journée de caisse en double')
    return lignes, total


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('pdf', type=Path)
    p.add_argument('json', type=Path)
    args = p.parse_args()
    lignes, total = lire(args.pdf)
    print(len(lignes), len({l['date'] for l in lignes}), total)
    args.json.write_text(json.dumps({'version': 1, 'lignes': lignes}), encoding='utf-8')
