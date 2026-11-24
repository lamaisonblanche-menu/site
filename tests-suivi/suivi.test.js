'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { lignesVentes, lireCouts } = require('../app/core/suivi.js');

const date = '2026-11-24', ts = Date.parse(date + 'T12:00:00Z');
const ligne = { id: 'l1', pid: 'produit', nom: 'Plat', catNom: 'Cuisine', qte: 1, prix: 100, par: 's1', envoye: ts };
const ticket = { num: 1, date, ts, salle: 'gastro', table: '1', cmdId: 'c1', caissier: 'Caisse', mode: 'especes', net: 100, lignes: [ligne] };
const base = { tickets: [ticket], users: [{ id: 's1', nom: 'Vendeur actuel' }], jours: [{ id: 'j1', date }], commandes: {} };
const couts = new Map([['produit', [{ depuis: date, centimes: 3000 }, { depuis: '2026-10-01', centimes: 2000 }]]]);
const rapports = (db = base, q = {}, options = {}) => lignesVentes(db, q, date, message => { throw Error(message); },
  { exportComplet: false, couts, salleNom: s => s, ...options });

test('net, personne de saisie, famille et heure d’Alger', () => {
  const r = rapports();
  assert.equal(r.lignes[0].vendeur, 'Vendeur actuel');
  assert.equal(r.lignes[0].heure, '13 h');
  assert.equal(r.lignes[0].famille, 'Cuisine');
  assert.equal(r.totaux.net, 100);
  assert.equal(r.totaux.margeCentimes, 7000);
});
test('QR distingué même pour un historique où le valideur figurait dans la ligne', () => {
  const t = { ...ticket, lignes: [{ ...ligne, source: 'qr', saisiPar: 'Valideur' }] };
  assert.equal(rapports({ ...base, tickets: [t] }, { grouper: 'origine' }).groupes[0].nom, 'QR code');
  assert.equal(rapports({ ...base, tickets: [t] }).lignes[0].vendeur, 'QR code');
});
test('remise répartie sans écart de centime entre groupes et ticket', () => {
  const t = { ...ticket, net: 155, lignes: [ligne, { ...ligne, nom: 'Deuxième plat', prix: 93 }] };
  const r = rapports({ ...base, tickets: [t] });
  assert.equal(r.lignes.reduce((s, l) => s + l.net, 0), 155);
  assert.equal(r.totaux.remises, 38);
  assert.equal(r.groupes.reduce((s, g) => s + g.net, 0), 155);
});
test('offert et annulé distincts, coût de l’offert conservé', () => {
  const tickets = [{ ...ticket, mode: 'offert', net: 0 }, { ...ticket, num: 2, annule: true }];
  const r = rapports({ ...base, tickets });
  assert.equal(r.totaux.net, 0);
  assert.equal(r.totaux.offerts, 1);
  assert.equal(r.totaux.annules, 1);
  assert.equal(r.totaux.margeCentimes, -3000);
});
test('annulation avant ticket avec date de la journée de caisse', () => {
  const l = { ...ligne, annule: { ts } };
  const r = rapports({ ...base, tickets: [], commandes: { c1: { id: 'c1', jour: 'j1', salle: 'gastro', lignes: [l] } } });
  assert.equal(r.lignes[0].ticket, null);
  assert.equal(r.totaux.valeurAnnulee, 100);
});
test('annulation historique présente à deux endroits comptée une fois', () => {
  const l = { ...ligne, annule: { ts } };
  const r = rapports({ ...base, tickets: [{ ...ticket, net: 0, lignes: [l] }], commandes: { c1: { id: 'c1', jour: 'j1', salle: 'gastro', lignes: [l] } } });
  assert.equal(r.totaux.annules, 1);
});
test('coûts manquants et options payantes exclus de la marge connue', () => {
  const t = { ...ticket, net: 300, lignes: [ligne, { ...ligne, pid: 'inconnu' }, { ...ligne, opts: [{ prix: 10 }] }] };
  const r = rapports({ ...base, tickets: [t] });
  assert.equal(r.totaux.qteAvecCout, 1);
  assert.equal(r.totaux.qteSansCout, 2);
  assert.equal(r.totaux.margeCentimes, 7000);
});
test('coût historique et nom de saisie conservés', () => {
  const t = { ...ticket, date: '2026-11-01', lignes: [{ ...ligne, saisiPar: 'Nom au moment de la vente' }] };
  const r = rapports({ ...base, tickets: [t] }, { du: '2026-11-01' });
  assert.equal(r.lignes[0].coutCentimes, 2000);
  assert.equal(r.lignes[0].vendeur, 'Nom au moment de la vente');
});
test('filtres croisés, pagination et export complet', () => {
  const tickets = Array.from({ length: 115 }, (_, i) => ({ ...ticket, num: i + 1 }));
  const db = { ...base, tickets };
  assert.equal(rapports(db, { offset: 100, famille: 'Cuisine', vendeur: 'Vendeur actuel' }).lignes.length, 15);
  assert.equal(rapports(db, { offset: 100 }, { exportComplet: true }).lignes.length, 115);
  assert.equal(rapports(db, { salle: 'brunch' }).total, 0);
});
test('dates invalides, jour vide, dossier coûts absent', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'couts-'));
  try {
    assert.throws(() => rapports(base, { du: '2026-02-30' }), /invalide/);
    assert.throws(() => rapports(base, { du: '2026-11-25' }), /invalide/);
    assert.equal(rapports({ ...base, tickets: [] }).totaux.margeCentimes, null);
    assert.equal(lireCouts(dir).size, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('fichier de coûts local, versions triées et valeur décimale exacte', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'couts-'));
  try {
    writeFileSync(path.join(dir, 'couts-matiere.json'), JSON.stringify([
      { articleId: 'produit', depuis: '2026-10-01', dinars: 19 },
      { articleId: 'produit', depuis: date, dinars: 31.29 },
      { articleId: 'produit', depuis: '2026-02-30', dinars: 5 },
      { articleId: 'autre', depuis: date, dinars: -1 },
    ]));
    const c = lireCouts(dir);
    assert.equal(c.size, 1);
    assert.deepEqual(c.get('produit').map(x => x.centimes), [3129, 1900]);
    assert.equal(rapports(base, {}, { couts: c }).lignes[0].margeCentimes, 6871);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
async function portLibre() {
  const serveur = net.createServer();
  await new Promise((resolve, reject) => serveur.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = serveur.address();
  await new Promise(resolve => serveur.close(resolve));
  return port;
}

test('serveur réel, accès aux seuls rapports, ventes en direct et CSV', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'srvmb-'));
  const portCaisse = await portLibre(), portSuivi = await portLibre(), secret = randomBytes(32).toString('hex');
  const caisse = 'http://127.0.0.1:' + portCaisse, suivi = 'http://127.0.0.1:' + portSuivi;
  const headers = { Authorization: 'Bearer ' + secret };
  writeFileSync(path.join(dir, 'suivi-srvmb.json'), JSON.stringify({ hote: '127.0.0.1', port: portSuivi, secret }));
  const enfant = spawn(process.execPath, [path.join(__dirname, '../app/core/server.js')], {
    env: { ...process.env, PORT: String(portCaisse), CAISSE_DATA: dir }, stdio: 'ignore',
  });
  t.after(async () => {
    if (enfant.exitCode == null && enfant.signalCode == null) {
      const fin = new Promise(resolve => enfant.once('exit', resolve));
      enfant.kill();
      await fin;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    page = await fetch(suivi).catch(() => null);
    if (!page) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(page?.status, 200);
  await t.test('page et ressources locales, API protégée', async () => {
    assert.match(await page.text(), /Suivi des ventes/);
    assert.equal((await fetch(suivi + '/suivi.js')).status, 200);
    assert.equal((await fetch(suivi + '/suivi.css')).status, 200);
    assert.equal((await fetch(suivi + '/api/rapports')).status, 401);
    assert.equal((await fetch(suivi + '/api/export.csv')).status, 401);
    assert.equal((await fetch(suivi + '/api/rapports', { headers: { Authorization: 'Bearer mauvais' } })).status, 401);
  });
  await t.test('port de suivi sans caisse, modification ni sauvegarde', async () => {
    assert.equal((await fetch(suivi + '/api/etat', { headers })).status, 404);
    assert.equal((await fetch(suivi + '/export/sauvegarde.json', { headers })).status, 404);
    assert.equal((await fetch(suivi + '/api/rapports', { method: 'POST', headers })).status, 405);
    assert.equal((await fetch(caisse + '/api/etat', { headers })).status, 401);
  });
  await t.test('vide, filtres et export autorisé', async () => {
    const r = await fetch(suivi + '/api/rapports', { headers });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).rapport.total, 0);
    assert.equal((await fetch(suivi + '/api/rapports?du=2026-02-30', { headers })).status, 400);
    const exportCsv = await fetch(suivi + '/api/export.csv', { headers });
    assert.match(exportCsv.headers.get('content-type'), /text\/csv/);
    assert.match(await exportCsv.text(), /Ticket;Date;Saisie/);
  });
  await t.test('activation en caisse, même port, clé séparée et révocable', async () => {
    const url = caisse + '/suivi/';
    const post = (route, data, token) => fetch(caisse + route, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Token': token || '' }, body: JSON.stringify(data) });
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await fetch(url + 'suivi.js')).status, 200);
    assert.equal((await fetch(url + 'api/rapports', { headers })).status, 401);
    assert.equal((await post('/api/admin/suivi-bureau', {})).status, 401);
    const admin = (await (await post('/api/login', { pin: '1234' })).json()).token;
    const config = async b => (await post('/api/admin/suivi-bureau', b, admin)).json();
    const acces = await config({});
    assert.match(acces.cle, /^[a-f0-9]{64}$/);
    const lecture = { Authorization: 'Bearer ' + acces.cle };
    assert.equal((await fetch(url + 'api/rapports', { headers: lecture })).status, 200);
    assert.equal((await fetch(caisse + '/api/etat', { headers: lecture })).status, 401);
    assert.equal((await fetch(url + 'api/rapports', { method: 'POST', headers: lecture })).status, 405);
    assert.notEqual((await config({renouveler:true})).cle, acces.cle);
    assert.equal((await fetch(url + 'api/rapports', { headers: lecture })).status, 401);
    assert.equal((await config({desactiver:true})).actif, false);
  });
  await t.test('vente réelle reflétée avant et après encaissement', async () => {
    async function api(route, body, token) {
      const r = await fetch(caisse + route, { method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', 'X-Token': token || '' }, body: body ? JSON.stringify(body) : undefined });
      const j = await r.json();
      assert.equal(r.status, 200, j.erreur);
      return j;
    }
    const serveur = (await api('/api/login', { pin: '2000' })).token;
    const caissier = (await api('/api/login', { pin: '1009' })).token;
    const etat = await api('/api/etat', null, serveur);
    const article = etat.produits.find(p => p.actif && p.prix > 0 && !p.options.length && p.id !== 'supplement-fixe');
    const c = await api('/api/commande/ouvrir', { salle: 'brunch', table: '20' }, serveur);
    await api('/api/commande/envoyer', { id: c.id, lignes: [{ pid: article.id, qte: 2 }] }, serveur);
    let rapport = await (await fetch(suivi + '/api/rapports', { headers })).json();
    assert.equal(rapport.ouvert.montant, 2 * article.prix);
    assert.equal(rapport.synthese.ca, 0);
    await api('/api/commande/encaisser', { id: c.id, mode: 'especes', recu: 2 * article.prix }, caissier);
    rapport = await (await fetch(suivi + '/api/rapports', { headers })).json();
    assert.equal(rapport.synthese.ca, 2 * article.prix);
    assert.equal(rapport.rapport.totaux.net, rapport.synthese.ca);
    assert.equal(rapport.ouvert.montant, 0);
    assert.equal(rapport.rapport.totaux.qteSansCout, 2);
    assert.equal(rapport.rapport.lignes[0].article, article.nom);
    await api('/api/rase', { compte: 2 * article.prix - 10 }, caissier);
    rapport = await (await fetch(suivi + '/api/rapports', { headers })).json();
    assert.equal(rapport.ouvert, null);
    assert.equal(rapport.synthese.rases[0].ecart, -10);
    assert.equal(rapport.synthese.ca, 2 * article.prix);
  });
});

test('appairage du PC du bureau : code, acceptation par le responsable, refus, révocation (3.7.1)', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'appairage-'));
  const port = await portLibre(), caisse = 'http://127.0.0.1:' + port;
  const enfant = spawn(process.execPath, [path.join(__dirname, '../app/core/server.js')], {
    env: { ...process.env, PORT: String(port), CAISSE_DATA: dir }, stdio: 'ignore',
  });
  t.after(async () => {
    if (enfant.exitCode == null && enfant.signalCode == null) { const fin = new Promise(r => enfant.once('exit', r)); enfant.kill(); await fin; }
    rmSync(dir, { recursive: true, force: true });
  });
  let id;
  for (let i = 0; i < 60 && !id; i++) {
    id = await fetch(caisse + '/suivi/api/identite').then(r => r.json()).catch(() => null);
    if (!id) await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(id.logiciel, 'caisse-la-maison-blanche');
  assert.equal(id.appairage, true);
  assert.equal(id.bureauActif, false);
  const post = (route, data, token) => fetch(caisse + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': token || '' }, body: JSON.stringify(data) }).then(r => r.json());
  const demander = () => post('/suivi/api/appairage', { poste: 'SRV-MB <script>' });
  const etat = d => fetch(caisse + '/suivi/api/appairage?demande=' + d).then(r => r.json());
  const d1 = await demander();
  assert.match(d1.code, /^\d{6}$/);
  assert.equal((await etat(d1.demande)).etat, 'attente');
  assert.equal((await etat('inconnue')).etat, 'expire');
  // un serveur ou un caissier ne peut pas accepter
  const caissier = (await post('/api/login', { pin: '1009' })).token;
  assert.match((await post('/api/admin/suivi-bureau', { accepter: d1.demande }, caissier)).erreur, /responsable/);
  const admin = (await post('/api/login', { pin: '1234' })).token;
  const liste = await post('/api/admin/suivi-bureau', { activer: true }, admin);
  assert.deepEqual(liste.demandes.map(d => [d.poste, d.code]), [['SRV-MB script', d1.code]]);
  await post('/api/admin/suivi-bureau', { accepter: d1.demande }, admin);
  const ok = await etat(d1.demande);
  assert.equal(ok.etat, 'accepte');
  assert.equal(ok.cle, liste.cle);
  assert.equal((await etat(d1.demande)).etat, 'expire', 'la clé n’est donnée qu’une fois');
  const lecture = { Authorization: 'Bearer ' + ok.cle };
  assert.equal((await fetch(caisse + '/suivi/api/rapports', { headers: lecture })).status, 200);
  assert.equal((await fetch(caisse + '/api/etat', { headers: { 'X-Token': ok.cle } })).status, 401, 'aucun droit de caisse');
  // refus
  const d2 = await demander();
  await post('/api/admin/suivi-bureau', { refuser: d2.demande }, admin);
  assert.equal((await etat(d2.demande)).etat, 'refuse');
  // limite de demandes en attente
  for (let i = 0; i < 5; i++) await demander();
  assert.match((await demander()).erreur, /Trop de demandes/);
  // révocation : la clé ne marche plus, les demandes en attente sont refusées
  assert.equal((await post('/api/admin/suivi-bureau', { desactiver: true }, admin)).actif, false);
  assert.equal((await fetch(caisse + '/suivi/api/rapports', { headers: lecture })).status, 401);
  assert.equal((await post('/api/admin/suivi-bureau', { activer: true }, admin)).demandes.length, 0);
});
