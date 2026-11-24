// Rapports La Maison Blanche — application Windows du PC du bureau (SRV MB)
// Affiche, dans sa propre fenêtre, les rapports en lecture seule de la caisse principale (/suivi/).
// Ce logiciel ne reçoit qu'une clé de CONSULTATION : aucun code de caissier, aucun droit sur la caisse.
'use strict';
const { app, BrowserWindow, ipcMain, Menu, dialog, safeStorage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const R = require('./reseau');

const NOM = 'Rapports La Maison Blanche';
app.setAppUserModelId('dz.lamaisonblanche.rapports');
if (!app.requestSingleInstanceLock()) app.quit();

const USER = process.env.LMB_RAPPORTS_DONNEES || app.getPath('userData');
const CONF = path.join(USER, 'bureau.json');
const LOG = path.join(USER, 'rapports.log');
const ICONE = path.join(__dirname, 'icon.png');
// réglages de test uniquement (essais automatiques) : port de la caisse et adresses à balayer
const ESSAI = {};
if (process.env.LMB_RAPPORTS_PORT) ESSAI.port = Number(process.env.LMB_RAPPORTS_PORT);
if (process.env.LMB_RAPPORTS_CIBLES) { ESSAI.cibles = process.env.LMB_RAPPORTS_CIBLES.split(','); ESSAI.reseaux = []; }

function log(...a) {
  try {
    fs.mkdirSync(USER, { recursive: true });
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 1e6) fs.renameSync(LOG, LOG + '.ancien');
    fs.appendFileSync(LOG, new Date().toISOString() + ' ' + a.join(' ') + '\n');
  } catch {}
}

// ------------------------------------------------------------------ Réglages (caisse associée + clé chiffrée par Windows)
let conf = {};
try { conf = JSON.parse(fs.readFileSync(CONF, 'utf8')); } catch {}
function sauver() { fs.mkdirSync(USER, { recursive: true }); fs.writeFileSync(CONF, JSON.stringify(conf, null, 2)); }
function lireCle() {
  try {
    if (conf.cleChiffree) return safeStorage.decryptString(Buffer.from(conf.cleChiffree, 'base64'));
    return conf.cleClaire || '';
  } catch (e) { log('clé illisible :', e.message); return ''; }
}
function enregistrerAssociation(caisse, cle) {
  conf.caisse = { adresse: caisse.adresse, port: caisse.port || R.PORT_CAISSE, nom: caisse.nom || '' };
  delete conf.cleChiffree; delete conf.cleClaire;
  if (safeStorage.isEncryptionAvailable()) conf.cleChiffree = safeStorage.encryptString(cle).toString('base64');
  else conf.cleClaire = cle;
  conf.associeLe = new Date().toISOString();
  sauver();
  log('associé à', conf.caisse.adresse, conf.caisse.nom);
}
function oublierCle() { delete conf.cleChiffree; delete conf.cleClaire; sauver(); }
const origine = () => conf.caisse ? 'http://' + conf.caisse.adresse + ':' + (conf.caisse.port || R.PORT_CAISSE) : '';

// ------------------------------------------------------------------ Fenêtre
let win = null, etat = { ecran: 'recherche' }, surRapports = false, dernierContact = 0;
function fenetre() {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    width: 1366, height: 860, minWidth: 900, minHeight: 600, show: false, title: NOM, icon: ICONE, backgroundColor: '#f4f3f0',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  win.once('ready-to-show', () => { win.maximize(); win.show(); });
  win.on('page-title-updated', e => e.preventDefault());
  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e, url) => {
    if (url.startsWith('file:') || (origine() && url.startsWith(origine() + '/suivi/'))) return;
    e.preventDefault();
  });
  wc.on('did-finish-load', () => {
    if (surRapports) wc.insertCSS('#connexion,#deconnexion{display:none!important}');
  });
  wc.on('did-fail-load', (e, code, desc, url, principal) => {
    if (principal && surRapports && !url.startsWith('file:')) { log('chargement impossible :', desc); horsLigne(); }
  });
  wc.on('render-process-gone', () => setTimeout(() => (surRapports ? ouvrirRapports() : afficher(etat)), 1000));
  wc.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown') return;
    if (i.key === 'F5') { e.preventDefault(); surRapports ? wc.reloadIgnoringCache() : relancer(); }
    if (i.control && i.shift && i.key.toLowerCase() === 'i') wc.toggleDevTools();
  });
  // export CSV : on propose de l'enregistrer dans Documents
  wc.session.on('will-download', (e, item) => {
    const nom = item.getFilename() || 'ventes.csv';
    item.setSaveDialogOptions({ title: 'Enregistrer l’export des ventes', defaultPath: path.join(process.env.LMB_RAPPORTS_EXPORTS || app.getPath('documents'), nom), filters: [{ name: 'Fichier CSV (Excel)', extensions: ['csv'] }] });
    if (process.env.LMB_RAPPORTS_EXPORTS) item.setSavePath(path.join(process.env.LMB_RAPPORTS_EXPORTS, nom));
    item.once('done', (ev, s) => log('export', nom, s, item.getSavePath()));
  });
  // la direction a retiré ou renouvelé la clé pendant l'affichage
  wc.session.webRequest.onCompleted({ urls: ['http://*/suivi/api/*'] }, d => {
    if (d.statusCode === 401 && surRapports) verifierAcces();
    else if (d.statusCode === 200) dernierContact = Date.now();
  });
  return win;
}
function afficher(nouvel) {
  etat = nouvel;
  surRapports = false;
  const w = fenetre();
  w.setTitle(NOM);
  const url = 'file://' + path.join(__dirname, 'ecran.html').replace(/\\/g, '/');
  if (!w.webContents.getURL().startsWith('file:')) w.loadFile(path.join(__dirname, 'ecran.html'));
  else w.webContents.send('etat', etat);
  log('écran', etat.ecran);
  return url;
}
function ouvrirRapports() {
  surRapports = true;
  dernierContact = Date.now();
  etat = { ecran: 'rapports' };
  const w = fenetre();
  w.setTitle(NOM + ' — caisse ' + (conf.caisse.nom || conf.caisse.adresse));
  w.loadURL(origine() + '/suivi/');
  log('rapports ouverts', origine());
}

// ------------------------------------------------------------------ Connexion à la caisse associée
let enCours = null, minuterie = null;
function relancer() { clearTimeout(minuterie); return demarrer(); }
function demarrer() {
  if (enCours) return enCours;
  enCours = (async () => {
    const cle = lireCle();
    if (!conf.caisse || !cle) return appairer();
    if (!surRapports && etat.ecran !== 'hors') afficher({ ecran: 'connexion', caisse: conf.caisse });
    const r = await R.retrouver({ caisse: conf.caisse, cle }, ESSAI);
    if (r.etat === 'ok') {
      if (r.caisse.adresse !== conf.caisse.adresse) { log('caisse retrouvée à une nouvelle adresse', r.caisse.adresse); enregistrerAssociation(r.caisse, cle); }
      return ouvrirRapports();
    }
    if (r.etat === 'refusee') { oublierCle(); return afficher({ ecran: 'retire', caisse: conf.caisse }); }
    if (r.etat === 'ancienne') return afficher({ ecran: 'ancienne', caisse: conf.caisse });
    return horsLigne();
  })().catch(e => { log('erreur :', e.stack || e.message); horsLigne(); }).finally(() => { enCours = null; });
  return enCours;
}
function horsLigne() {
  surRapports = false;
  afficher({ ecran: 'hors', caisse: conf.caisse, dernier: dernierContact || null, essai: Date.now() });
  clearTimeout(minuterie);
  minuterie = setTimeout(() => demarrer(), 10000);
}
async function verifierAcces() {
  if (!conf.caisse) return;
  const e = await R.verifierCle(conf.caisse, lireCle());
  if (e === 'refusee') { log('accès retiré par la direction'); oublierCle(); afficher({ ecran: 'retire', caisse: conf.caisse }); }
}
// surveillance pendant l'affichage des rapports : caisse éteinte ou débranchée → écran clair, puis reprise toute seule
let echecs = 0;
setInterval(async () => {
  if (!surRapports || !conf.caisse) return;
  const v = await R.verifierCle(conf.caisse, lireCle(), 4000);
  if (!surRapports) return;
  if (v === 'refusee') { log('accès retiré par la direction'); oublierCle(); return afficher({ ecran: 'retire', caisse: conf.caisse }); }
  if (v === 'ok' || v === 'ancienne') { echecs = 0; dernierContact = Date.now(); return; }
  if (++echecs >= 2) { echecs = 0; log('caisse injoignable'); horsLigne(); }
}, 10000);

// ------------------------------------------------------------------ Premier lancement : appairage
let appairage = null; // { caisse, demande, code }
async function appairer() {
  arreterAppairage();
  afficher({ ecran: 'recherche' });
  const caisses = await R.chercherCaisses({ ...ESSAI, connue: conf.caisse });
  log('caisses trouvées :', caisses.map(c => c.adresse + ' v' + c.version).join(', ') || 'aucune');
  if (!caisses.length) return afficher({ ecran: 'introuvable', reseaux: R.reseauxLocaux().map(r => r.adresse) });
  for (const c of caisses) {
    const id = await R.identite(c);
    if (id.appairage) { if (id.nom) c.nom = id.nom; return lancerDemande(c); }
  }
  // caisse 3.7.0 : pas encore d'appairage par code, la clé se recopie à la main (adresse déjà trouvée)
  afficher({ ecran: 'manuel', caisse: caisses[0], raison: 'ancienne' });
}
async function lancerDemande(caisse) {
  try {
    const d = await R.demanderAppairage(caisse, os.hostname());
    appairage = { caisse: { ...caisse, nom: d.caisse || caisse.nom }, demande: d.demande, code: d.code };
    afficher({ ecran: 'code', caisse: appairage.caisse, code: d.code });
    suivreDemande();
  } catch (e) {
    afficher({ ecran: 'manuel', caisse, raison: 'erreur', message: e.message });
  }
}
function suivreDemande() {
  clearTimeout(appairage?.t);
  if (!appairage) return;
  appairage.t = setTimeout(async () => {
    if (!appairage) return;
    const r = await R.etatAppairage(appairage.caisse, appairage.demande);
    if (!appairage) return;
    if (r.etat === 'accepte' && r.cle) {
      const caisse = appairage.caisse; arreterAppairage();
      enregistrerAssociation(caisse, r.cle);
      return ouvrirRapports();
    }
    if (r.etat === 'refuse') { const c = appairage.caisse; arreterAppairage(); return afficher({ ecran: 'refuse', caisse: c }); }
    if (r.etat === 'expire') return lancerDemande(appairage.caisse);
    if (r.etat === 'hors') afficher({ ...etat, horsLigne: true }); else if (etat.horsLigne) afficher({ ...etat, horsLigne: false });
    suivreDemande();
  }, 2000);
}
function arreterAppairage() { if (appairage) clearTimeout(appairage.t); appairage = null; }

// ------------------------------------------------------------------ Actions de l'écran
ipcMain.handle('etat', () => etat);
ipcMain.handle('reessayer', () => { arreterAppairage(); return relancer(); });
ipcMain.handle('associer', () => { arreterAppairage(); oublierCle(); return appairer(); });
ipcMain.handle('manuel', async (e, { adresse, cle }) => {
  cle = String(cle || '').replace(/\s+/g, '').toLowerCase();
  adresse = String(adresse || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const [ip, port] = adresse.split(':');
  if (!/^[a-f0-9]{64}$/.test(cle)) return { erreur: 'La clé fait 64 caractères (chiffres et lettres de a à f). Vérifiez-la.' };
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return { erreur: 'Adresse de la caisse incorrecte.' };
  const caisse = { adresse: ip, port: Number(port) || ESSAI.port || R.PORT_CAISSE };
  const v = await R.verifierCle(caisse, cle);
  if (v === 'hors') return { erreur: 'La caisse ne répond pas à cette adresse. Vérifiez qu’elle est allumée.' };
  if (v === 'refusee') return { erreur: 'Clé refusée par la caisse. Recopiez la clé affichée dans Gestion → Réglages → Rapports du bureau.' };
  if (v !== 'ok') return { erreur: 'Cette caisse n’a pas encore le module Rapports du bureau.' };
  arreterAppairage();
  enregistrerAssociation(caisse, cle);
  ouvrirRapports();
  return { ok: true };
});
ipcMain.handle('ouvrirJournal', () => shell.showItemInFolder(LOG));
// la page des rapports lit la clé au chargement, seulement si elle vient de la caisse associée
ipcMain.on('cle-rapports', e => {
  const url = e.senderFrame?.url || '';
  e.returnValue = surRapports && origine() && url.startsWith(origine() + '/suivi/') ? lireCle() : '';
});

// ------------------------------------------------------------------ Menu
function menu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Rapports', submenu: [
      { label: 'Actualiser', accelerator: 'F5', click: () => (surRapports ? win.webContents.reloadIgnoringCache() : relancer()) },
      { type: 'separator' },
      { label: 'Associer à nouveau la caisse…', click: async () => {
        const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['Associer à nouveau', 'Annuler'], defaultId: 1, cancelId: 1, title: NOM, message: 'Refaire l’association avec la caisse principale ?', detail: 'Ce PC oubliera sa clé de consultation. Il faudra accepter la nouvelle demande sur la caisse (Gestion → Réglages → Rapports du bureau).' });
        if (r.response === 0) { arreterAppairage(); oublierCle(); appairer(); }
      } },
      { label: 'Ouvrir le journal du logiciel', click: () => shell.showItemInFolder(LOG) },
      { type: 'separator' },
      { label: 'Quitter', role: 'quit' },
    ] },
    { label: 'Affichage', submenu: [{ role: 'zoomIn', label: 'Agrandir' }, { role: 'zoomOut', label: 'Réduire' }, { role: 'resetZoom', label: 'Taille normale' }, { role: 'togglefullscreen', label: 'Plein écran' }] },
    { label: 'Aide', submenu: [{ label: 'À propos', click: () => dialog.showMessageBox(win, { title: NOM, message: NOM + ' ' + app.getVersion(), detail: 'Consultation des ventes de la caisse principale, en lecture seule.' + (conf.caisse ? '\nCaisse associée : ' + (conf.caisse.nom || '') + ' (' + conf.caisse.adresse + ')' : '') }) }] },
  ]));
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
app.whenReady().then(() => { log('démarrage', app.getVersion()); menu(); fenetre(); demarrer(); });
