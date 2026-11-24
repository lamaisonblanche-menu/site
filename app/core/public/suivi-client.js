'use strict';
const el = id => document.getElementById(id);
const monnaies = new Intl.NumberFormat('fr-DZ', { maximumFractionDigits: 2 });
const dinars = valeur => valeur == null ? '—' : monnaies.format(valeur) + ' DA';
const centimes = valeur => dinars(valeur == null ? null : valeur / 100);
const heure = ts => ts ? new Date(ts).toLocaleTimeString('fr-DZ', { timeZone: 'Africa/Algiers', hour: '2-digit', minute: '2-digit' }) : '—';
const axes = { article: 'Article', famille: 'Famille', vendeur: 'Vendeur', salle: 'Salle', origine: 'Origine', statut: 'Statut', heure: 'Heure de saisie', date: 'Jour' };
let secret = '', offset = 0, requete = 0, choix = {};
function noeud(tag, texte) {
  const n = document.createElement(tag);
  if (texte != null) n.textContent = texte;
  return n;
}
function tableau(id, colonnes, lignes) {
  if (!lignes.length) return el(id).replaceChildren(noeud('p', 'Aucun résultat.'));
  const table = noeud('table'), entete = table.createTHead().insertRow(), corps = table.createTBody();
  for (const c of colonnes) entete.append(noeud('th', c));
  for (const l of lignes) {
    const tr = corps.insertRow();
    for (const cellule of l) tr.append(noeud('td', cellule));
  }
  el(id).replaceChildren(table);
}
function aujourdhui() {
  const d = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Africa/Algiers', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const v = k => d.find(p => p.type === k).value;
  return v('year') + '-' + v('month') + '-' + v('day');
}
function datesDuJour() {
  el('periode').elements.du.value = aujourdhui();
  el('periode').elements.au.value = aujourdhui();
}
function params() { return new URLSearchParams({ ...Object.fromEntries(new FormData(el('periode'))), ...choix, offset }); }
async function appeler(route) {
  const r = await fetch(route + '?' + params(), { headers: { Authorization: 'Bearer ' + secret }, cache: 'no-store' });
  if (!r.ok) {
    const erreur = await r.json();
    throw new Error(erreur.erreur);
  }
  return r;
}
function filtresDisponibles(report) {
  function select(cle, titre, valeurs, tous) {
    const label = noeud('label', titre), champ = noeud('select');
    if (tous) champ.add(new Option('Tous', ''));
    for (const [valeur, nom] of valeurs) champ.add(new Option(nom, valeur));
    champ.value = choix[cle] || (cle === 'grouper' ? 'article' : '');
    if (champ.selectedIndex < 0 && tous) champ.add(new Option(choix[cle], choix[cle], false, true));
    champ.addEventListener('change', () => { choix[cle] = champ.value; offset = 0; charger(); });
    label.append(champ);
    return label;
  }
  el('filtres').replaceChildren(select('grouper', 'Regrouper par', Object.entries(axes)),
    ...Object.entries(report.filtres).map(([cle, v]) => select(cle, axes[cle], v.map(n => [n, n]), true)));
}
function afficher({ rapport: r, synthese: s, ouvert }) {
  const cards = [
    ['CA net', dinars(s.ca)], ['Période précédente (' + s.precedentDu + ' au ' + s.precedentAu + ')', dinars(s.precedent)], ['Écart de CA', dinars(s.ca - s.precedent)],
    ['Tickets', s.nbTickets], ['Ticket moyen', dinars(s.ticketMoyen)], ['Couverts', s.couverts],
    ['Espèces', dinars(s.especes)], ['Carte', dinars(s.tpe)], ['Chèques', dinars(s.cheque)], ['Sur facture', dinars(s.societe)], ['Sorties de caisse', dinars(s.sorties)],
  ];
  if (ouvert) cards.push(['Tables à encaisser', ouvert.tables], ['Reste à encaisser', dinars(ouvert.montant)]);
  el('synthese').replaceChildren(...cards.map(([titre, valeur]) => {
    const bloc = noeud('dl'); bloc.append(noeud('dt', titre), noeud('dd', valeur)); return bloc;
  }));
  function barres(id, donnees, label) {
    const max = Math.max(1, ...donnees.map(([, montant]) => montant));
    el(id).replaceChildren(...donnees.map(([cle, montant]) => {
      const ligne = noeud('div'), m = noeud('meter'); ligne.className = 'barre';
      const titre = label(cle);
      m.min = 0; m.max = max; m.value = Math.max(0, montant); m.setAttribute('aria-label', 'CA · ' + titre);
      ligne.append(noeud('span', titre), m, noeud('span', dinars(montant))); return ligne;
    }));
    if (!donnees.length) el(id).append(noeud('p', 'Aucune vente sur la période.'));
  }
  barres('jours', Object.entries(s.jours).sort(([a], [b]) => a.localeCompare(b)).slice(-31), jour => jour.slice(5));
  barres('heures', Object.entries(s.heures), h => h.padStart(2, '0') + ' h');
  filtresDisponibles(r);
  const t = r.totaux;
  el('couverture').textContent = 'Sélection · Net ' + dinars(t.net) + ' · Remises ' + dinars(t.remises) +
    ' · Offerts ' + dinars(t.valeurOfferte) + ' · Annulés ' + dinars(t.valeurAnnulee) +
    ' · Marge matière calculée sur ' + t.qteAvecCout + ' unité(s) · ' + t.qteSansCout + ' sans coût.';
  tableau('groupes', ['Groupe', 'Vendus', 'Offerts', 'Annulés', 'Net', 'Remises', 'Coût matière connu', 'Marge matière connue', 'Sans coût'],
    r.groupes.map(g => [g.nom, g.vendus, g.offerts, g.annules, dinars(g.net), dinars(g.remises), centimes(g.qteAvecCout ? g.coutCentimes : null), centimes(g.margeCentimes), g.qteSansCout]));
  tableau('lignes', ['Ticket', 'Jour', 'Saisie', 'Encaissement', 'Salle', 'Table', 'Article', 'Famille', 'Origine', 'Vendeur', 'Caissier', 'Qté', 'Prix unitaire', 'Net', 'Statut', 'Coût matière', 'Marge'],
    r.lignes.map(l => [l.ticket ?? '—', l.date, heure(l.saisiA), heure(l.encaisseA), l.salle, l.table, l.article, l.famille, l.origine, l.vendeur, l.caissier || '—', l.qte, dinars(l.prix), dinars(l.net), l.statut, centimes(l.coutCentimes), centimes(l.margeCentimes)]));
  tableau('clotures', ['Clôture', 'Jour', 'CA', 'Attendu', 'Compté', 'Écart'], s.rases.map(c => [c.n, c.date, dinars(c.ca), dinars(c.attendu), dinars(c.compte), dinars(c.ecart)]));
  el('page').textContent = r.total ? (r.offset + 1) + '–' + Math.min(r.offset + 100, r.total) + ' sur ' + r.total : '0 ligne';
  el('precedent').disabled = !r.offset;
  el('suivant').disabled = r.offset + 100 >= r.total;
}
async function charger() {
  const n = ++requete;
  try {
    const resultat = await (await appeler('/api/rapports')).json();
    if (n !== requete) return;
    afficher(resultat);
    el('rapports').hidden = false;
    el('connexion').hidden = true;
    el('deconnexion').hidden = false;
    el('etat').textContent = 'Actualisé à ' + heure(Date.now()) + ' · heure d’Alger';
  } catch (e) {
    if (n === requete) el('etat').textContent = e.message;
  }
}
el('connexion').onsubmit = e => { e.preventDefault(); secret = e.target.elements.secret.value.trim(); e.target.reset(); charger(); };
el('deconnexion').onclick = () => location.reload();
el('periode').onsubmit = e => { e.preventDefault(); choix = {}; offset = 0; charger(); };
el('aujourdhui').onclick = () => { datesDuJour(); choix = {}; offset = 0; charger(); };
el('precedent').onclick = () => { offset = Math.max(0, offset - 100); charger(); };
el('suivant').onclick = () => { offset += 100; charger(); };
el('export').onclick = async () => {
  try {
    const r = await appeler('/api/export.csv'), url = URL.createObjectURL(await r.blob()), a = noeud('a');
    a.href = url; a.download = 'ventes-' + el('periode').elements.du.value + '.csv'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { el('etat').textContent = e.message; }
};
datesDuJour();
setInterval(() => { if (!el('rapports').hidden && !el('filtres').contains(document.activeElement) && !el('periode').contains(document.activeElement)) charger(); }, 30000);
