// Caisse La Maison Blanche — application Windows
// Deux façons de l'utiliser :
//  • « Caisse principale » : ce PC fait tourner la caisse (données, imprimantes) et l'affiche.
//  • « Écran de salle »    : ce PC affiche la caisse principale (serveurs, écran cuisine).
'use strict';
const { app, BrowserWindow, ipcMain, shell, dialog, Menu, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const dgram = require('dgram');
const { fork } = require('child_process');
const maj = require('./maj');

const PORT = 8080, PORT_DECOUVERTE = 41234;
app.setAppUserModelId('dz.lamaisonblanche.caisse');
if (!app.requestSingleInstanceLock()) { app.quit(); }

const USER = app.getPath('userData');
const CONF = path.join(USER, 'config.json');
const DATA = path.join(USER, 'data');
const CORES = path.join(USER, 'core');
const LOG = path.join(USER, 'caisse.log');
const EMBARQUE = app.isPackaged ? path.join(process.resourcesPath, 'core') : path.join(__dirname, 'core');
const ICONE = path.join(__dirname, 'icon.png');

let conf = {};
try { conf = JSON.parse(fs.readFileSync(CONF, 'utf8')); } catch (e) {}
const sauverConf = () => { fs.mkdirSync(USER, { recursive: true }); fs.writeFileSync(CONF, JSON.stringify(conf, null, 2)); };

function log(...a) {
  try {
    const l = new Date().toISOString() + ' ' + a.join(' ') + '\n';
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 2e6) fs.renameSync(LOG, LOG + '.ancien');
    fs.appendFileSync(LOG, l);
  } catch (e) {}
}

// ------------------------------------------------------------------ Fenêtre
let win = null, setupWin = null;
function fenetre() {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    width: 1280, height: 800, fullscreen: true, autoHideMenuBar: true, backgroundColor: '#111111', show: false,
    title: 'Caisse La Maison Blanche', icon: ICONE,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown') return;
    if (i.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    if (i.key === 'F5' || (i.control && i.key.toLowerCase() === 'r')) { win.webContents.reloadIgnoringCache(); e.preventDefault(); }
    if (i.control && i.shift && i.key.toLowerCase() === 'i') win.webContents.toggleDevTools();
    if (i.control && i.shift && i.key.toLowerCase() === 'q') quitter();
  });
  // les liens externes (WhatsApp…) s'ouvrent dans le navigateur
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(adresseCaisse())) { e.preventDefault(); shell.openExternal(url); } });
  win.webContents.on('did-fail-load', (e, code, desc, url, principal) => { if (principal && !url.startsWith('file:')) attente(); });
  win.webContents.on('render-process-gone', () => setTimeout(() => charger(), 1000));
  win.on('closed', () => { win = null; if (!quitte) app.quit(); });
  return win;
}
const adresseCaisse = () => 'http://' + (conf.mode === 'principale' ? '127.0.0.1' : conf.adresse) + ':' + PORT;
function charger() { fenetre().loadURL(adresseCaisse() + '/'); }
// page « recherche de la caisse principale »
let tAttente = null;
function attente() {
  const w = fenetre();
  w.loadFile(path.join(__dirname, 'attente.html'), { query: { mode: conf.mode || '', adresse: conf.adresse || '' } });
  clearTimeout(tAttente);
  tAttente = setTimeout(async () => {
    if (conf.mode === 'poste') {
      const ok = await joignable(conf.adresse);
      if (!ok) { const l = await decouvrir(); if (l.length) { conf.adresse = l[0].adresse; sauverConf(); log('caisse principale retrouvée à', conf.adresse); } }
    }
    if (await joignable(conf.mode === 'principale' ? '127.0.0.1' : conf.adresse)) charger(); else attente();
  }, 4000);
}
function joignable(hote) {
  return new Promise(res => {
    if (!hote) return res(false);
    const r = http.get({ host: hote, port: PORT, path: '/api/version', timeout: 2500 }, x => { x.resume(); res(x.statusCode === 200); });
    r.on('timeout', () => r.destroy()); r.on('error', () => res(false));
  });
}

// ------------------------------------------------------------------ Serveur de caisse (PC principal)
let serveur = null, coreActif = null, departServeur = 0, crashs = 0, redemarrageVoulu = false, quitte = false;
const etatMaj = { version: null, verifie: null, prete: null, erreur: null, notes: '' };
function lancerServeur() {
  coreActif = maj.coreAUtiliser(CORES, EMBARQUE);
  etatMaj.version = coreActif.version;
  departServeur = Date.now();
  log('démarrage de la caisse, version', coreActif.version, coreActif.dir);
  fs.mkdirSync(DATA, { recursive: true });
  serveur = fork(path.join(coreActif.dir, 'server.js'), [], {
    cwd: coreActif.dir, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CAISSE_DATA: DATA, PORT: String(PORT), CAISSE_APP: '1' },
  });
  serveur.stdout.on('data', d => log('[caisse]', String(d).trim()));
  serveur.stderr.on('data', d => log('[caisse ERREUR]', String(d).trim()));
  serveur.on('message', m => {
    if (m.type === 'pret') { envoyerEtat(); if (!win || win.webContents.getURL().startsWith('file:')) charger(); }
    if (m.type === 'verifier') verifierMaj(true);
    if (m.type === 'installer') installerMaj(true);
  });
  serveur.on('exit', code => {
    log('la caisse s\'est arrêtée, code', code);
    serveur = null;
    if (quitte) return;
    if (code === 3) {
      dialog.showMessageBox({ type: 'error', title: 'Caisse La Maison Blanche', message: 'Une autre caisse tourne déjà sur ce PC (port ' + PORT + ' occupé).', detail: 'Fermez l\'ancienne caisse (fenêtre noire « Lancer la caisse ») puis relancez l\'application.' }).then(() => app.quit());
      return;
    }
    if (!redemarrageVoulu) {
      crashs = Date.now() - departServeur < 20000 ? crashs + 1 : 0;
      // une nouvelle version qui plante deux fois de suite est abandonnée : retour à la précédente
      if (crashs >= 2 && coreActif.telecharge) { log('version', coreActif.version, 'abandonnée'); maj.marquerMauvaise(CORES, coreActif.version); crashs = 0; }
    }
    redemarrageVoulu = false;
    if (win) attente();
    setTimeout(lancerServeur, 1500);
  });
}
function envoyerEtat() { try { if (serveur && serveur.connected) serveur.send({ type: 'maj', etat: { ...etatMaj, app: app.getVersion(), canal: maj.CANAL } }); } catch (e) {} }
let verifEnCours = false;
async function verifierMaj(manuel) {
  if (verifEnCours || conf.mode !== 'principale') return;
  verifEnCours = true;
  try {
    const r = await maj.verifier(CORES, coreActif ? coreActif.version : '0.0.0');
    etatMaj.verifie = Date.now(); etatMaj.erreur = null;
    if (r.prete && maj.cmp(r.prete, coreActif.version) > 0) { etatMaj.prete = r.prete; etatMaj.notes = r.notes; log('mise à jour prête', r.prete); }
  } catch (e) { etatMaj.erreur = e.message; etatMaj.verifie = Date.now(); if (manuel) log('mise à jour impossible :', e.message); }
  verifEnCours = false;
  envoyerEtat();
}
// on installe seulement quand aucune table n'est ouverte et que personne n'a touché la caisse depuis 3 minutes
function calme() {
  return new Promise(res => {
    const r = http.get({ host: '127.0.0.1', port: PORT, path: '/api/calme', timeout: 3000 }, x => { let s = ''; x.on('data', c => (s += c)); x.on('end', () => { try { res(JSON.parse(s).calme); } catch (e) { res(false); } }); });
    r.on('timeout', () => r.destroy()); r.on('error', () => res(false));
  });
}
async function installerMaj(force) {
  if (!etatMaj.prete || !serveur) return;
  if (!force && !(await calme())) return;
  log('installation de la version', etatMaj.prete);
  etatMaj.prete = null; redemarrageVoulu = true;
  serveur.kill();
}

// ------------------------------------------------------------------ Découverte de la caisse principale sur le réseau
let ecoute = null;
function repondreDecouverte() {
  ecoute = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  ecoute.on('message', (msg, r) => { if (String(msg) === 'MB-CAISSE?') ecoute.send(Buffer.from('MB-CAISSE!' + JSON.stringify({ nom: os.hostname(), port: PORT })), r.port, r.address); });
  ecoute.on('error', e => log('découverte :', e.message));
  ecoute.bind(PORT_DECOUVERTE);
}
function decouvrir() {
  return new Promise(res => {
    const trouves = new Map();
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.on('message', (msg, r) => { const t = String(msg); if (t.startsWith('MB-CAISSE!')) { let info = {}; try { info = JSON.parse(t.slice(10)); } catch (e) {} trouves.set(r.address, { adresse: r.address, nom: info.nom || r.address }); } });
    s.on('error', () => {});
    s.bind(() => {
      s.setBroadcast(true);
      const cibles = new Set(['255.255.255.255']);
      for (const i of Object.values(os.networkInterfaces()).flat()) {
        if (!i || i.family !== 'IPv4' || i.internal) continue;
        const ip = i.address.split('.').map(Number), m = i.netmask.split('.').map(Number);
        cibles.add(ip.map((x, k) => (x & m[k]) | (~m[k] & 255)).join('.'));
      }
      for (const c of cibles) s.send('MB-CAISSE?', PORT_DECOUVERTE, c, () => {});
    });
    setTimeout(() => { try { s.close(); } catch (e) {} res([...trouves.values()]); }, 1800);
  });
}

// ------------------------------------------------------------------ Premier lancement
function ecranReglage() {
  if (setupWin && !setupWin.isDestroyed()) return setupWin.focus();
  setupWin = new BrowserWindow({
    width: 760, height: 640, resizable: false, autoHideMenuBar: true, title: 'Caisse La Maison Blanche — installation', icon: ICONE, backgroundColor: '#f4f3f0',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  setupWin.loadFile(path.join(__dirname, 'setup.html'), { query: { mode: conf.mode || '', adresse: conf.adresse || '' } });
  setupWin.on('closed', () => { setupWin = null; if (!conf.mode) app.quit(); });
}
function demarrer() {
  if (conf.mode === 'principale') {
    recupererAncienneCaisse();
    repondreDecouverte();
    attente();
    lancerServeur();
    setTimeout(() => verifierMaj(), 20000);
    setInterval(() => verifierMaj(), 15 * 60000);
    setInterval(() => installerMaj(false), 60000);
  } else {
    attente();
  }
}
// si la caisse a d'abord été installée à la main (dossier C:\CaisseMB), on reprend ses données
function recupererAncienneCaisse() {
  try {
    if (fs.existsSync(path.join(DATA, 'caisse.json'))) return;
    for (const d of ['C:\\CaisseMB\\data', path.join(os.homedir(), 'Downloads', 'CaisseMB', 'data'), path.join(os.homedir(), 'Desktop', 'CaisseMB', 'data')]) {
      if (fs.existsSync(path.join(d, 'caisse.json'))) { fs.cpSync(d, DATA, { recursive: true }); log('données reprises depuis', d); break; }
    }
    // l'ancien lancement automatique (fenêtre noire) n'est plus utile
    const ancien = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Caisse La Maison Blanche.lnk');
    if (fs.existsSync(ancien)) fs.unlinkSync(ancien);
  } catch (e) { log('reprise des anciennes données :', e.message); }
}
function raccourcis() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
}

// ------------------------------------------------------------------ Échanges avec les écrans
ipcMain.handle('info', () => ({ mode: conf.mode, adresse: conf.adresse, app: app.getVersion(), coeur: coreActif ? coreActif.version : null, donnees: conf.mode === 'principale' ? DATA : null, ip: ipsLocales() }));
ipcMain.handle('decouvrir', () => decouvrir());
ipcMain.handle('tester', (e, ip) => joignable(ip));
ipcMain.handle('choisir', (e, c) => {
  const premier = !conf.mode;
  const avant = conf.mode;
  conf = { ...conf, mode: c.mode === 'principale' ? 'principale' : 'poste', adresse: c.mode === 'poste' ? String(c.adresse || '').trim() : '' };
  sauverConf(); raccourcis();
  if (setupWin) setupWin.destroy();
  if (premier || avant !== conf.mode) { app.relaunch(); quitter(); } else attente();
  return true;
});
ipcMain.handle('reglages', () => { ecranReglage(); return true; });
ipcMain.handle('quitter', () => { quitter(); return true; });
ipcMain.handle('dossier', () => { if (conf.mode === 'principale') shell.openPath(DATA); return true; });
ipcMain.handle('journal', () => { shell.openPath(LOG); return true; });
function ipsLocales() { return Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address); }

function quitter() {
  quitte = true;
  try { if (ecoute) ecoute.close(); } catch (e) {}
  if (serveur) { serveur.once('exit', () => app.exit(0)); serveur.kill(); setTimeout(() => app.exit(0), 4000); } else app.exit(0);
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } else if (setupWin) setupWin.focus(); });
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  powerSaveBlocker.start('prevent-display-sleep');
  if (!conf.mode) ecranReglage(); else demarrer();
});
app.on('window-all-closed', () => {});
app.on('before-quit', () => { quitte = true; if (serveur) serveur.kill(); });
