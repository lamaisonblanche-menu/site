// Rapports La Maison Blanche — export PDF des rapports (fait sur le PC du bureau, la caisse n'est pas modifiée)
'use strict';
const R = require('./reseau');

const AXES = { article: 'Article', famille: 'Famille', vendeur: 'Serveur', salle: 'Salle', origine: 'Origine', statut: 'Statut', heure: 'Heure de saisie', date: 'Jour' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nombre = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });
const da = v => v == null ? '—' : nombre.format(v) + ' DA';
const cts = v => da(v == null ? null : v / 100);
const heure = ts => ts ? new Date(ts).toLocaleTimeString('fr-FR', { timeZone: 'Africa/Algiers', hour: '2-digit', minute: '2-digit' }) : '—';
const jourFr = d => d ? d.split('-').reverse().join('/') : '';

// Lit toutes les données de la période et des filtres choisis à l'écran (toutes les pages de lignes).
async function lireDonnees(caisse, cle, params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v) q.set(k, v);
  const lire = async offset => {
    q.set('offset', String(offset));
    const r = await R.requete(caisse.adresse, caisse.port, '/suivi/api/rapports?' + q, { cle, delai: 20000 });
    if (r.status === 401) throw Object.assign(new Error('Accès retiré par la direction'), { refusee: true });
    if (!r.ok) throw new Error(r.json?.erreur || 'La caisse ne répond pas');
    return r.json;
  };
  const premiere = await lire(0);
  const lignes = [...premiere.rapport.lignes];
  for (let offset = lignes.length; offset < premiere.rapport.total && offset < 20000; offset += 100) {
    const suite = await lire(offset);
    if (!suite.rapport.lignes.length) break;
    lignes.push(...suite.rapport.lignes);
  }
  return { ...premiere, lignes };
}

function table(colonnes, lignes, classe = '') {
  if (!lignes.length) return '<p class="vide">Aucun résultat.</p>';
  return `<table class="${classe}"><thead><tr>${colonnes.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>` +
    lignes.map(l => '<tr>' + l.map(c => `<td>${esc(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>';
}

function html({ rapport: r, synthese: s, ouvert, lignes }, params, caisse) {
  const filtres = Object.entries(AXES).filter(([k]) => params?.[k]).map(([k, n]) => n + ' : ' + params[k]);
  const cartes = [
    ['CA net', da(s.ca)], ['Période précédente', da(s.precedent)], ['Écart de CA', da(s.ca - s.precedent)],
    ['Tickets', s.nbTickets], ['Ticket moyen', da(s.ticketMoyen)], ['Couverts', s.couverts],
    ['Espèces', da(s.especes)], ['Carte', da(s.tpe)], ['Chèques', da(s.cheque)], ['Sur facture', da(s.societe)], ['Sorties de caisse', da(s.sorties)],
  ];
  if (ouvert) cartes.push(['Tables à encaisser', ouvert.tables], ['Reste à encaisser', da(ouvert.montant)]);
  const t = r.totaux;
  const parJour = Object.entries(s.jours || {}).sort(([a], [b]) => a.localeCompare(b)).map(([j, m]) => [jourFr(j), da(m)]);
  const parHeure = Object.entries(s.heures || {}).map(([h, m]) => [h.padStart(2, '0') + ' h', da(m)]);
  const groupe = AXES[params?.grouper] || 'Article';
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Rapport des ventes</title><style>
    @page { size: A4 landscape; margin: 12mm 10mm; }
    body { font: 10pt "Segoe UI", Arial, sans-serif; color: #1d1d1b; margin: 0; }
    header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #1d1d1b; padding-bottom: 6px; margin-bottom: 10px; }
    header h1 { margin: 0; font-size: 18pt; } header p { margin: 0; color: #555; }
    h2 { font-size: 12pt; margin: 14px 0 6px; page-break-after: avoid; }
    .cartes { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; }
    .cartes div { border: 1px solid #ccc; border-radius: 4px; padding: 5px 7px; } .cartes span { display: block; color: #555; font-size: 8.5pt; } .cartes b { font-size: 11pt; }
    table { width: 100%; border-collapse: collapse; font-size: 8.5pt; } th, td { border-bottom: 1px solid #ddd; padding: 3px 4px; text-align: left; }
    th { background: #f0eee9; } thead { display: table-header-group; } tr { page-break-inside: avoid; }
    .deux { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; } .note { color: #555; font-size: 9pt; } .vide { color: #777; }
  </style></head><body>
  <header><div><p>La Maison Blanche · Hydra</p><h1>Rapport des ventes</h1></div>
  <div style="text-align:right"><b>Du ${esc(jourFr(r.du))} au ${esc(jourFr(r.au))}</b><p>Édité le ${esc(new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Algiers', dateStyle: 'short', timeStyle: 'short' }))} · caisse ${esc(caisse.nom || caisse.adresse)}</p>${filtres.length ? `<p>Filtres : ${esc(filtres.join(' · '))}</p>` : ''}</div></header>
  <h2>Synthèse</h2><div class="cartes">${cartes.map(([n, v]) => `<div><span>${esc(n)}</span><b>${esc(v)}</b></div>`).join('')}</div>
  <p class="note">Sélection · Net ${esc(da(t.net))} · Remises ${esc(da(t.remises))} · Offerts ${esc(da(t.valeurOfferte))} · Annulés ${esc(da(t.valeurAnnulee))} · Marge matière calculée sur ${t.qteAvecCout} unité(s), ${t.qteSansCout} sans coût de revient.</p>
  <div class="deux"><div><h2>Ventes par jour</h2>${table(['Jour', 'CA'], parJour)}</div><div><h2>Encaissements par heure</h2>${table(['Heure', 'CA'], parHeure)}</div></div>
  <h2>Analyse par ${esc(groupe.toLowerCase())}</h2>
  ${table([groupe, 'Vendus', 'Offerts', 'Annulés', 'Net', 'Remises', 'Coût matière', 'Marge matière', 'Sans coût'], r.groupes.map(g => [g.nom, g.vendus, g.offerts, g.annules, da(g.net), da(g.remises), cts(g.qteAvecCout ? g.coutCentimes : null), cts(g.margeCentimes), g.qteSansCout]))}
  <h2>Lignes de vente (${lignes.length})</h2>
  ${table(['Ticket', 'Jour', 'Saisie', 'Encaiss.', 'Salle', 'Table', 'Article', 'Options', 'Famille', 'Origine', 'Serveur', 'Caissier', 'Qté', 'Prix', 'Net', 'Statut', 'Marge'],
    lignes.map(l => [l.ticket ?? '—', jourFr(l.date), heure(l.saisiA), heure(l.encaisseA), l.salle, l.table, l.article, l.options || '', l.famille, l.origine, l.vendeur, l.caissier || '—', l.qte, da(l.prix), da(l.net), l.statut, cts(l.margeCentimes)]))}
  <h2>Clôtures et écarts</h2>
  ${table(['Clôture', 'Jour', 'CA', 'Attendu', 'Compté', 'Écart'], s.rases.map(c => [c.n, jourFr(c.date), da(c.ca), da(c.attendu), da(c.compte), da(c.ecart)]))}
  </body></html>`;
}

module.exports = { lireDonnees, html, AXES };
