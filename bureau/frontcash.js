'use strict';

const CHAMPS = ['Ent', 'Det', 'Reg', 'Esp', 'Chq', 'Tpe', 'Deb', 'Off', 'Aut', 'Diff'];

function valider(source) {
  if (source?.version !== 1 || !Array.isArray(source.lignes) || !source.lignes.length) {
    throw new Error('Fichier FrontCash invalide.');
  }
  const vus = new Set();
  for (const l of source.lignes) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(l.date) || !/^(MASTER C1|GASTRO C2|BRUNCH C3|TERRASSE C4)$/.test(l.caisse) ||
        CHAMPS.some(c => !Number.isSafeInteger(l[c])) ||
        l.Reg !== l.Esp + l.Chq + l.Tpe + l.Deb + l.Off + l.Aut) {
      throw new Error('Ligne FrontCash invalide.');
    }
    const id = l.date + ' ' + l.caisse;
    if (vus.has(id)) throw new Error('Ligne FrontCash en double.');
    vus.add(id);
  }
  return source.lignes.filter(l => l.date < '2026-11-23');
}

function fusionner(donnees, lignes) {
  const { rapport: r, synthese: s } = donnees;
  const actifs = lignes.filter(l => l.date >= r.du && l.date <= r.au);
  const precedents = lignes.filter(l => l.date >= s.precedentDu && l.date <= s.precedentAu);
  if (!actifs.length && !precedents.length) return donnees;
  const somme = (ls, champ) => ls.reduce((n, l) => n + l[champ], 0) / 100;
  const jours = { ...s.jours };
  for (const l of actifs) jours[l.date] = (jours[l.date] || 0) + l.Reg / 100;
  return { ...donnees, synthese: {
    ...s, jours, ca: s.ca + somme(actifs, 'Reg'), precedent: s.precedent + somme(precedents, 'Reg'),
    especes: s.especes + somme(actifs, 'Esp'), cheque: s.cheque + somme(actifs, 'Chq'),
    tpe: s.tpe + somme(actifs, 'Tpe'),
    frontcashJours: [...new Set(actifs.map(l => l.date))],
    frontcashPrecedent: precedents.length > 0,
    rases: [...s.rases, ...actifs.map(l => ({ n: 'FrontCash · ' + l.caisse, date: l.date, ca: l.Reg / 100 }))]
      .sort((a, b) => a.date.localeCompare(b.date)),
  } };
}

module.exports = { valider, fusionner };
