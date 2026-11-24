// Essai complet de l'application « Rapports La Maison Blanche » contre une vraie caisse de test.
// Usage : node tests/e2e.js <dossier des captures> [chemin de l'exe installé]
// Sans exe : lance l'application depuis les sources avec Electron.
'use strict';
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const CAPTURES = path.resolve(process.argv[2] || 'captures');
const EXE = process.argv[3];
const RACINE = path.join(__dirname, '..');
const SERVEUR = path.join(RACINE, '..', 'app', 'core', 'server.js');
fs.mkdirSync(CAPTURES, { recursive: true });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-rapports-'));
const DONNEES_APP = path.join(TMP, 'appdata'), DONNEES_CAISSE = path.join(TMP, 'caisse'), EXPORTS = path.join(TMP, 'exports');
fs.mkdirSync(EXPORTS, { recursive: true });
const pause = ms => new Promise(r => setTimeout(r, ms));
const resultats = [];
function ok(nom, detail = '') { resultats.push(['OK', nom, detail]); console.log('OK   ' + nom + (detail ? ' — ' + detail : '')); }

async function portLibre() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
let PORT, caisse;
const URLC = () => 'http://127.0.0.1:' + PORT;
async function demarrerCaisse() {
  caisse = spawn(process.execPath, [SERVEUR], { env: { ...process.env, PORT: String(PORT), CAISSE_DATA: DONNEES_CAISSE }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(URLC() + '/api/version')).ok) return; } catch {} await pause(100); }
  throw new Error('caisse de test non démarrée');
}
async function arreterCaisse() { const fin = new Promise(r => caisse.once('exit', r)); caisse.kill(); await fin; }
async function api(route, body, token) {
  const r = await fetch(URLC() + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Token': token || '' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(route + ' : ' + (j.erreur || r.status));
  return j;
}
async function lancerApp() {
  const env = { ...process.env, LMB_RAPPORTS_DONNEES: DONNEES_APP, LMB_RAPPORTS_PORT: String(PORT), LMB_RAPPORTS_CIBLES: '127.0.0.1', LMB_RAPPORTS_EXPORTS: EXPORTS };
  delete env.ELECTRON_RUN_AS_NODE;
  const appli = EXE ? await electron.launch({ executablePath: EXE, args: [], env }) : await electron.launch({ executablePath: require('electron'), args: [RACINE], env });
  const page = await appli.firstWindow();
  return { appli, page };
}
async function attendre(fn, ms, quoi) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) { try { const v = await fn(); if (v) return v; } catch {} await pause(300); }
  throw new Error('Délai dépassé : ' + quoi);
}
const ecran = page => page.evaluate(() => document.body.dataset.ecran || (location.pathname.startsWith('/suivi/') ? 'rapports' : ''));
async function capture(page, nom) { await page.screenshot({ path: path.join(CAPTURES, nom + '.png') }); }

(async () => {
  PORT = await portLibre();
  await demarrerCaisse();
  const admin = (await api('/api/login', { pin: '1234' })).token;

  // 1. premier lancement : détection + code d'appairage
  let { appli, page } = await lancerApp();
  await attendre(async () => (await ecran(page)) === 'code', 30000, 'écran du code');
  const code = (await page.textContent('#code')).replace(/\s/g, '');
  await capture(page, '1-code-appairage');
  ok('Détection automatique de la caisse et affichage du code', 'code ' + code);
  // 2. le responsable accepte sur la caisse
  const liste = await api('/api/admin/suivi-bureau', { activer: true }, admin);
  const demande = liste.demandes.find(d => d.code === code);
  if (!demande) throw new Error('demande introuvable sur la caisse');
  await api('/api/admin/suivi-bureau', { accepter: demande.id }, admin);
  await attendre(async () => page.url().includes('/suivi/') && await page.isVisible('#rapports'), 20000, 'ouverture des rapports');
  await capture(page, '2-rapports-ouverts');
  ok('Acceptation sur la caisse → rapports ouverts dans la fenêtre', page.url());
  const conf = JSON.parse(fs.readFileSync(path.join(DONNEES_APP, 'bureau.json'), 'utf8'));
  if (!conf.cleChiffree && process.platform === 'win32') throw new Error('clé non chiffrée par Windows');
  if (process.platform === 'win32' && JSON.stringify(conf).includes(liste.cle)) throw new Error('clé en clair dans bureau.json');
  ok('Clé gardée chiffrée sur le disque', conf.cleChiffree ? 'safeStorage' : 'claire (hors Windows)');

  // 3. une vente en direct puis après encaissement
  const serveur = (await api('/api/login', { pin: '2000' })).token, caissier = (await api('/api/login', { pin: '1009' })).token;
  const etat = await api('/api/etat', null, serveur);
  const article = etat.produits.find(p => p.actif && p.prix > 0 && !p.options.length && p.id !== 'supplement-fixe');
  const c = await api('/api/commande/ouvrir', { salle: 'brunch', table: '21' }, serveur);
  await api('/api/commande/envoyer', { id: c.id, lignes: [{ pid: article.id, qte: 2 }] }, serveur);
  await page.click('#aujourdhui');
  await attendre(async () => { const t = (await page.textContent('#synthese')).replace(/\s/g, ''); return t.includes('Resteàencaisser') && t.includes(String(2 * article.prix)); }, 15000, 'vente en direct (reste à encaisser)');
  await capture(page, '3-vente-en-direct');
  ok('Vente en cours visible en direct (table ouverte, reste à encaisser)', article.nom + ' ×2 = ' + 2 * article.prix + ' DA');
  await api('/api/commande/encaisser', { id: c.id, mode: 'especes', recu: 2 * article.prix }, caissier);
  await page.click('#aujourdhui');
  await attendre(async () => { const t = await page.textContent('#lignes'); return t.includes('Mustapha') && t.includes('Vendu'); }, 15000, 'vente encaissée');
  const ligne = await page.$$eval('#lignes tbody tr', trs => trs.map(tr => [...tr.cells].map(td => td.textContent)));
  await capture(page, '4-vente-encaissee');
  ok('Vente encaissée : qui, quoi, prix, heure', JSON.stringify(ligne[0]));
  // 4. filtre par famille et par serveur
  const famille = ligne[0][8];
  await page.selectOption('#filtres label:nth-child(3) select', famille);
  await attendre(async () => (await page.textContent('#lignes')).includes(article.nom), 8000, 'filtre famille');
  await page.selectOption('#filtres label:nth-child(4) select', 'Mustapha');
  await attendre(async () => (await page.textContent('#couverture')).includes('Net'), 8000, 'filtre vendeur');
  await capture(page, '5-filtres');
  ok('Filtres famille et serveur', famille + ' / Mustapha');
  // 5. export CSV
  await page.click('#export');
  const csv = await attendre(() => { const f = fs.readdirSync(EXPORTS).find(n => n.endsWith('.csv')); return f && fs.statSync(path.join(EXPORTS, f)).size > 50 && fs.readFileSync(path.join(EXPORTS, f), 'utf8'); }, 15000, 'export CSV');
  if (!csv.includes(article.nom) || !csv.includes('Marge')) throw new Error('CSV incomplet');
  fs.writeFileSync(path.join(CAPTURES, 'export-ventes.csv'), csv);
  ok('Export CSV enregistré', fs.readdirSync(EXPORTS).join(', '));

  // 6. fermeture puis relance : reconnexion directe sans code
  await appli.close();
  ({ appli, page } = await lancerApp());
  await attendre(async () => page.url().includes('/suivi/') && await page.isVisible('#rapports'), 30000, 'reconnexion au relancement');
  await capture(page, '6-relance-reconnexion');
  ok('Relance du logiciel : reconnexion directe, sans nouvel appairage');

  // 7. caisse éteinte puis rallumée
  await arreterCaisse();
  await attendre(async () => (await ecran(page)) === 'hors', 45000, 'écran hors ligne');
  await capture(page, '7-caisse-hors-ligne');
  ok('Caisse éteinte : message « Caisse principale hors ligne »');
  await demarrerCaisse();
  await attendre(async () => page.url().includes('/suivi/') && await page.isVisible('#rapports'), 30000, 'retour en ligne');
  ok('Caisse rallumée : les rapports reviennent seuls');

  // 8. révocation par la direction
  const admin2 = (await api('/api/login', { pin: '1234' })).token;
  await api('/api/admin/suivi-bureau', { desactiver: true }, admin2);
  await page.keyboard.press('F5');
  await attendre(async () => (await ecran(page)) === 'retire', 30000, 'écran accès retiré');
  await capture(page, '8-acces-retire');
  ok('Clé désactivée sur la caisse : « Accès retiré par la direction »');
  await appli.close();
  ({ appli, page } = await lancerApp());
  await attendre(async () => (await ecran(page)) === 'code', 30000, 'nouvel appairage après révocation');
  await capture(page, '9-apres-revocation');
  ok('Après révocation, relance : nouvelle demande d’accès (plus d’accès aux rapports)');
  await appli.close();
  await arreterCaisse();
  fs.writeFileSync(path.join(CAPTURES, 'resultats.txt'), resultats.map(r => r.join(' | ')).join('\n') + '\n');
  console.log('\nTOUS LES ESSAIS RÉUSSIS (' + resultats.length + ')');
  process.exit(0);
})().catch(async e => {
  console.error('ÉCHEC :', e.message);
  fs.writeFileSync(path.join(CAPTURES, 'resultats.txt'), resultats.map(r => r.join(' | ')).join('\n') + '\nÉCHEC | ' + e.message + '\n');
  try { caisse?.kill(); } catch {}
  process.exit(1);
});
