// Caisse La Maison Blanche — serveur local (aucune dépendance, Node 18+)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const os = require('os');
const { execFile } = require('child_process');
const tls = require('tls');

const PORT = +process.env.PORT || 8080;
const DIR = __dirname;
const DATA = process.env.CAISSE_DATA || path.join(DIR, 'data');
let VERSION = 'dev'; try { VERSION = fs.readFileSync(path.join(DIR, 'VERSION'), 'utf8').trim(); } catch (e) {}
// échanges avec l'application Windows (mises à jour)
let majEtat = null;
if (process.send) process.on('message', m => { if (m && m.type === 'maj') { majEtat = m.etat; broadcast(); } });
let derniereActivite = 0;
const DB_FILE = path.join(DATA, 'caisse.json');
const BACKUPS = path.join(DATA, 'sauvegardes');
const PRINTS = path.join(DATA, 'impressions-simulees');
for (const d of [DATA, BACKUPS, PRINTS]) fs.mkdirSync(d, { recursive: true });

// ---------------------------------------------------------------- Données
function slug(s) { return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

// Plans de salle repris de FrontCash (positions en % du plan, centre de la table)
function grille(cols, rows, places) {
  return places.map(([n, c, r]) => ({ n: String(n), x: +((c + .5) / cols * 100).toFixed(2), y: +((r + .5) / rows * 100).toFixed(2) }));
}
function sallesInitiales() {
  return [
    {
      id: 'gastro', nom: 'Gastro', fond: 'creme', ratio: 1.87, taille: 6.5,
      tables: [[1, 21.1, 23.8], [4, 37.6, 23.8], [7, 53.7, 23.8], [8, 69.9, 23.8], [11, 78.3, 23.8], [12, 78.9, 7.6], [14, 95.2, 7.6], [15, 95, 23.3], [16, 94.4, 37.8], [17, 93.8, 52.3], [18, 92.9, 66.9],
        [2, 22.4, 52.9], [5, 38.2, 52.9], [9, 61.5, 52.9], [10, 77.6, 52.9], [3, 23.3, 80.2], [6, 38.5, 80.2]].map(([n, x, y]) => ({ n: String(n), x, y })),
      deco: [{ type: 'bar', x: 55.3, y: 51 }, { type: 'caisse', x: 46.3, y: 92 }, { type: 'wc', x: 92, y: 92 }],
    },
    {
      id: 'brunch', nom: 'Brunch', fond: 'damier', ratio: 12 / 9, taille: 7.5, grille: [12, 9],
      tables: grille(12, 9, [[20, 0, 0], [25, 2, 0], [33, 8, 0], [35, 10, 0], [21, 0, 2], [26, 2, 2], [32, 6, 2], [34, 8, 2], [36, 10, 2],
        [22, 0, 4], [27, 2, 4], [30, 4, 4], [31, 6, 4], [37, 10, 4], [23, 0, 6], [28, 2, 6], [38, 10, 6], [24, 0, 8], [29, 2, 8]]),
      deco: [],
    },
    {
      id: 'terrasse', nom: 'Terrasse', fond: 'herbe', ratio: 12 / 7, taille: 7.5, grille: [12, 7],
      tables: grille(12, 7, [[103, 0, 0], [104, 1, 0], [105, 2, 0], [106, 3, 0], [107, 4, 0], [108, 5, 0], [109, 6, 0], [110, 7, 0], [111, 8, 0], [112, 9, 0], [113, 10, 0], [114, 11, 0],
        [116, 9, 1], [115, 11, 1], [102, 0, 2], [118, 9, 2], [117, 11, 2], [129, 5, 3], [119, 11, 3],
        [101, 0, 4], [128, 5, 4], [127, 7, 4], [121, 9, 4], [120, 11, 4], [122, 11, 5], [100, 0, 6], [126, 8, 6], [125, 9, 6], [124, 10, 6], [123, 11, 6]]),
      deco: [{ type: 'sapin', x: +((4.5 / 12) * 100).toFixed(2), y: +((6.5 / 7) * 100).toFixed(2) }],
    },
  ];
}
const IMPRIMANTES = () => ({
  ticket: { nom: 'Caisse (tickets clients)', ip: '', port: 9100 },
  cuisine: { nom: 'Cuisine principale', ip: '', port: 9100 },
  cuisine2: { nom: 'Cuisine 2', ip: '', port: 9100 },
  asiatique: { nom: 'Asiatique', ip: '', port: 9100 },
  comptoir: { nom: 'Comptoir', ip: '', port: 9100 },
});

function dbInitiale() {
  const seed = JSON.parse(fs.readFileSync(path.join(DIR, 'seed-menu.json'), 'utf8'));
  const categories = [], produits = [];
  seed.forEach(([nom, poste, couleur, items], i) => {
    const id = slug(nom);
    categories.push({ id, nom, poste, couleur, suite: suiteParDefaut(nom, poste), univers: universDefaut(nom, poste), ordre: i });
    items.forEach(([n, prix]) => produits.push({ id: 'p' + (produits.length + 1), nom: n, prix, cat: id, actif: true, options: [], stock: null }));
  });
  const options = optionsInitiales();
  for (const p of produits) if (CUISSON.test(p.nom)) p.options = ['cuisson'];
  return {
    version: 4, options,
    config: {
      nom: 'La Maison Blanche', adresse: '23 rue des Frères Ben Ali, Hydra - Alger', tel: '+213 541 55 96 72',
      piedTicket: 'Merci de votre visite - A bientot !',
      fondCaisse: 15000, tablePatron: '18',
      imprimantes: IMPRIMANTES(),
      largeur: 48, pageCode: 16, sansAccents: false, tiroirAuto: true,
      deconnexionServeurSec: 60, raseAuto: { actif: false, heure: '02:00', extinction: false },
      salles: sallesInitiales(),
      societes: [],
      motifsSortie: ['Influenceuse', 'Dépense du restaurant', 'Achat marché', 'Avance sur salaire', 'Autre'],
      motifsAnnulation: ['Erreur de saisie', 'Client a changé d\'avis', 'Plat refusé / retour', 'Rupture', 'Autre'],
      ...COMMENTAIRES(), ...TICKET_DEFAUT(),
    },
    users: [
      { id: 'u1', nom: 'Patron', role: 'admin', pin: '1234', badge: '', actif: true },
      { id: 'u2', nom: 'Caisse 1', role: 'caissier', pin: '1111', badge: '', actif: true },
      { id: 'u3', nom: 'Serveur 1', role: 'serveur', pin: '2222', badge: '', actif: true },
    ],
    categories, produits,
    commandes: {}, tickets: [], sorties: [], jours: [], journal: [],
    bons: [], pointages: [],
    seq: { ticket: 0, cmd: 0, ligne: 0, sortie: 0, jour: 0, bon: 0, pointage: 0, emporter: 0 },
  };
}
// Suites (ordre d'envoi en cuisine) : 0 = direct (boissons), 1 = entrées, 2 = plats, 3 = desserts
const SUITES = ['Direct', 'Entrées', 'Plats', 'Desserts', 'Suite 4', 'Suite 5'];
function suiteParDefaut(nom, poste) {
  if (poste === 'comptoir') return 0;
  if (/entr[ée]e|brunch/i.test(nom)) return 1;
  if (/dessert|cr[êe]pe|gaufre/i.test(nom)) return 3;
  return 2;
}
const CUISSON = /c[œo]e?ur de filet|c[ôo]te de b|entrec[ôo]te|burger b/i;
function optionsInitiales() {
  return [{ id: 'cuisson', nom: 'Cuisson', obligatoire: true, multiple: false, choix: ['Bleu', 'Saignant', 'À point', 'Bien cuit'].map(nom => ({ nom, prix: 0 })) }];
}

let db;
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
catch (e) {
  if (fs.existsSync(DB_FILE)) { console.error('Fichier de données illisible : ' + DB_FILE + '. Restaurez une sauvegarde du dossier data/sauvegardes.'); process.exit(1); }
  db = dbInitiale();
}
// Mise à jour d'une caisse déjà installée avec la première version
if ((db.version || 1) < 2) {
  const neuf = dbInitiale();
  const ip = (k) => (db.config.imprimantes[k] || {}).ip || '';
  db.config.imprimantes = IMPRIMANTES();
  db.config.imprimantes.ticket.ip = ip('ticket'); db.config.imprimantes.cuisine.ip = ip('cuisine'); db.config.imprimantes.comptoir.ip = ip('bar');
  if (!Object.values(db.commandes).some(c => c.statut === 'ouverte')) db.config.salles = neuf.config.salles;
  if (!db.tickets.length) { db.categories = neuf.categories; db.produits = neuf.produits; }
  for (const c of db.categories) { if (c.poste === 'bar') c.poste = 'comptoir'; if (!c.couleur) c.couleur = '#efe3cc'; }
  for (const u of db.users) if (u.badge === undefined) u.badge = '';
  db.version = 2;
}
// Commentaires rapides proposés aux serveurs (modifiables dans Gestion > Réglages)
function COMMENTAIRES() {
  return {
    commentaires: ['Sans oignon', 'Sans sauce', 'Sauce à part', 'Sans fromage', 'Sans gluten', 'Allergie', 'Peu épicé', 'Bien épicé', 'Bien chaud', 'Sans glaçons', 'Peu sucré', 'Sans sucre', 'À partager', 'Assiette enfant', 'Servir en premier'],
    commentairesCommande: ['Client pressé', 'Anniversaire', 'Allergie à signaler', 'Bébé à table', 'Tout servir ensemble', 'Client régulier', 'Prévoir une bougie'],
  };
}
function TICKET_DEFAUT() { return { logoTicket: true, qrLien: 'https://lamaisonblanchehydra.com', qrTexte: 'Réservez votre table en ligne - Instagram @restaurant_lamaisonblanche' }; }
function universDefaut(nom, poste) {
  if (/brunch|burger/i.test(nom)) return 'Brunch';
  if (/asiat/i.test(nom)) return 'Asiatique';
  if (/dessert|cr[êe]pe|gaufre/i.test(nom)) return 'Desserts';
  if (poste === 'comptoir' || /boisson|mocktail|jus|smoothie/i.test(nom)) return 'Boissons';
  return 'La carte';
}
// Mise à jour vers la version 3 (suites, options, ruptures, écran cuisine, pointage)
if (db.version < 3) {
  for (const c of db.categories) if (c.suite === undefined) c.suite = suiteParDefaut(c.nom, c.poste);
  db.options = db.options || optionsInitiales();
  for (const p of db.produits) { if (!Array.isArray(p.options)) p.options = CUISSON.test(p.nom) ? ['cuisson'] : []; if (p.stock === undefined) p.stock = null; }
  db.bons = db.bons || []; db.pointages = db.pointages || [];
  db.seq.bon = db.seq.bon || 0; db.seq.pointage = db.seq.pointage || 0;
  db.version = 3;
}
// version 4 : univers de la carte, commentaires, à emporter
if (db.version < 4) {
  for (const c of db.categories) if (!c.univers) c.univers = universDefaut(c.nom, c.poste);
  Object.assign(db.config, { ...COMMENTAIRES(), ...Object.fromEntries(Object.entries(db.config).filter(([k]) => k.startsWith('commentaires'))) });
  db.seq.emporter = db.seq.emporter || 0;
  for (const [k, v] of Object.entries(TICKET_DEFAUT())) if (db.config[k] === undefined) db.config[k] = v;
  db.version = 4;
}
// Équipe du restaurant, ajoutée une seule fois (version 3.2.3) : les personnes déjà présentes (même nom) ne sont pas touchées
if (!db.equipeInitiale) {
  const EQUIPE = [["Ihab", "serveur", "7430"], ["Moncef", "serveur", "4864"], ["Youcef", "serveur", "6058"], ["Mustapha", "serveur", "7080"], ["Zahir", "serveur", "4077"], ["Abdou", "serveur", "6194"], ["Wafi", "caissier", "3861"], ["Rayen", "caissier", "2130"], ["Walid", "cuisine", "8205"], ["Lotfi", "cuisine", "9428"], ["Lounis", "cuisine", "1372"], ["Salima", "cuisine", "4491"], ["Moh", "cuisine", "5360"], ["Youcef D.", "cuisine", "7998"]];
  for (const [nom, role, pin] of EQUIPE) {
    if (db.users.some(u => u.nom.toLowerCase() === nom.toLowerCase())) continue;
    let code = pin; while (db.users.some(u => u.pin === code)) code = String(1000 + Math.floor(Math.random() * 9000));
    db.users.push({ id: 'u-' + slug(nom), nom, role, pin: code, badge: '', actif: true });
  }
  // les comptes d'essai de départ ne servent plus
  for (const u of db.users) if ((u.nom === 'Caisse 1' && u.pin === '1111') || (u.nom === 'Serveur 1' && u.pin === '2222')) u.actif = false;
  db.equipeInitiale = true;
  setTimeout(() => saveNow(), 0);
}
// Équipe (version 3.2.5) : Rayan (orthographe corrigée), Lyes maître d'hôtel
if (!db.equipe2) {
  const ry = db.users.find(u => u.nom === 'Rayen'); if (ry) ry.nom = 'Rayan';
  if (!db.users.some(u => u.nom.toLowerCase() === 'lyes')) {
    let code = '9117'; while (db.users.some(u => u.pin === code)) code = String(1000 + Math.floor(Math.random() * 9000));
    db.users.push({ id: 'u-lyes', nom: 'Lyes', role: 'serveur', pin: code, badge: '', actif: true });
  }
  db.equipe2 = true;
  setTimeout(() => saveNow(), 0);
}
// Codes imposés par le gérant (version 3.3.3) : Mustapha 2000, Zoheir (chef de rang) 1993, Zahir 1996
if (!db.equipe3) {
  const CODES = [["Mustapha", "serveur", "2000"], ["Zoheir", "serveur", "1993"], ["Zahir", "serveur", "1996"]];
  for (const [nom, role, pin] of CODES) {
    let u = db.users.find(x => x.nom.toLowerCase() === nom.toLowerCase());
    if (!u) { u = { id: 'u-' + slug(nom), nom, role, pin: '', badge: '', actif: true }; db.users.push(u); }
    // si quelqu'un d'autre avait déjà ce code, il reçoit un nouveau code
    for (const o of db.users) if (o !== u && o.pin === pin) { let c; do c = String(1000 + Math.floor(Math.random() * 9000)); while (db.users.some(x => x.pin === c) || ['2000', '1993', '1996'].includes(c)); o.pin = c; }
    u.pin = pin; u.actif = true;
  }
  db.equipe3 = true;
  setTimeout(() => saveNow(), 0);
}
// Code imposé (version 3.3.4) : Lyes, maître d'hôtel, 1515
if (!db.equipe4) {
  let u = db.users.find(x => x.nom.toLowerCase() === 'lyes');
  if (!u) { u = { id: 'u-lyes', nom: 'Lyes', role: 'serveur', pin: '', badge: '', actif: true }; db.users.push(u); }
  for (const o of db.users) if (o !== u && o.pin === '1515') { let c; do c = String(1000 + Math.floor(Math.random() * 9000)); while (db.users.some(x => x.pin === c) || ['2000', '1993', '1996', '1515'].includes(c)); o.pin = c; }
  u.pin = '1515'; u.actif = true;
  db.equipe4 = true;
  setTimeout(() => saveNow(), 0);
}
// Postes (version 3.3.5) : crêpes, pancakes, desserts du brunch et fondant sortent au comptoir.
// Les desserts de la carte gastro (profiteroles, pavlova, crème brûlée, nougat) restent en cuisine, dans un groupe à part.
if (!db.postes5) {
  const vers = db.config.imprimantes.comptoir ? 'comptoir' : null;
  const des = db.categories.find(c => c.id === 'desserts');
  if (vers && des) {
    const GASTRO = ['Profiteroles chocolat', 'Pavlova', 'Crème brûlée', 'Nougat glacé fruits rouges'];
    if (!db.categories.some(c => c.id === 'desserts-carte')) {
      db.categories.push({ id: 'desserts-carte', nom: 'Desserts de la carte', poste: des.poste, couleur: des.couleur, suite: des.suite, univers: des.univers, ordre: des.ordre + 0.5 });
      db.categories.sort((a, b) => a.ordre - b.ordre).forEach((c, i) => (c.ordre = i));
    }
    for (const p of db.produits) if (p.cat === 'desserts' && GASTRO.includes(p.nom)) p.cat = 'desserts-carte';
    des.poste = vers;
    const cg = db.categories.find(c => c.id === 'crepes-et-gaufres'); if (cg) cg.poste = vers;
  }
  db.postes5 = true;
  setTimeout(() => saveNow(), 0);
}
// Desserts imprimés partout (version 3.3.6) : NY roll, Pavlova, Profiteroles, Mochis glacés (déjà sur la carte, 2 000 DA)
if (!db.partout6) {
  const cat = db.categories.find(c => c.id === 'desserts-carte') || db.categories.find(c => c.id === 'desserts');
  if (cat && !db.produits.some(p => /^mochi/i.test(p.nom))) db.produits.push({ id: 'ps-mochi', nom: 'Mochi', prix: 2000, cat: cat.id, actif: true, options: [], stock: null });
  for (const p of db.produits) if (/^ny roll|^pavlova|^profiterole|^mochi/i.test(p.nom)) p.partout = true;
  db.partout6 = true;
  setTimeout(() => saveNow(), 0);
}
// Plusieurs imprimantes (version 3.3.8) : Fondant chocolat glace et Nougat glacé sortent en cuisine ET au comptoir
if (!db.postes8) {
  for (const p of db.produits) if (/^fondant chocolat|^nougat glac/i.test(p.nom)) p.postes = ['cuisine', 'comptoir'];
  db.postes8 = true;
  setTimeout(() => saveNow(), 0);
}
// Boissons (version 3.3.9) : eaux en petit / grand modèle (PM 150, GM 200), sodas détaillés à 250 DA
if (!db.boissons9) {
  const ajouteApres = (ref, nom, prix) => {
    if (db.produits.some(p => p.nom.toLowerCase() === nom.toLowerCase())) return;
    db.seq.produit = (db.seq.produit || 0) + 1;
    const np = { id: 'ps9-' + db.seq.produit, nom, prix, cat: ref.cat, actif: true, options: [], stock: null };
    db.produits.splice(db.produits.indexOf(ref) + 1, 0, np); return np;
  };
  for (const [base, nom] of [['eau minérale', 'Eau minérale'], ['eau pétillante', 'Eau pétillante']]) {
    const e = db.produits.find(p => p.nom.toLowerCase() === base);
    if (e) { e.nom = nom + ' PM'; e.prix = 150; ajouteApres(e, nom + ' GM', 200); }
  }
  const soda = db.produits.find(p => p.nom.toLowerCase() === 'soda');
  if (soda) {
    let ref = soda;
    for (const n of ['Coca', 'Coca zéro', 'Selecto', 'Hamoud blanche']) ref = ajouteApres(ref, n, 250) || ref;
    soda.actif = false;
  }
  db.boissons9 = true;
  setTimeout(() => saveNow(), 0);
}
// Canettes (version 3.3.10) : Sprite et Schweppes à 250 DA, après Hamoud blanche
if (!db.boissons10) {
  let ref = db.produits.find(p => p.nom === 'Hamoud blanche') || db.produits.find(p => p.cat === 'boissons');
  if (ref) for (const nom of ['Sprite', 'Schweppes']) {
    if (db.produits.some(p => p.nom.toLowerCase() === nom.toLowerCase())) continue;
    db.seq.produit = (db.seq.produit || 0) + 1;
    const np = { id: 'ps10-' + db.seq.produit, nom, prix: 250, cat: ref.cat, actif: true, options: [], stock: null };
    db.produits.splice(db.produits.indexOf(ref) + 1, 0, np); ref = np;
  }
  db.boissons10 = true;
  setTimeout(() => saveNow(), 0);
}
// Réservations (version 3.5.0)
db.reservations = db.reservations || []; db.mailsAttente = db.mailsAttente || []; db.siteVus = db.siteVus || [];
db.config.raseAuto = db.config.raseAuto || { actif: false, heure: '02:00', extinction: false };
// Décision du gérant (24/11/2026) : la caisse ne doit jamais arrêter Windows.
// Neutralise aussi l'ancien réglage conservé dans les données des installations existantes.
db.config.raseAuto.extinction = false;
db.seq.resa = db.seq.resa || 0;
// Article autonome de supplément : migration idempotente, sans modifier les anciennes ventes.
if (!db.supplementArticle) {
  if (!db.produits.some(p => p.id === 'supplement-fixe')) {
    const cat = db.categories.find(c => c.poste === 'cuisine') || db.categories[0];
    if (cat) db.produits.push({ id: 'supplement-fixe', nom: 'Supplément', prix: 500, cat: cat.id, actif: true, options: [], stock: null });
  }
  db.supplementArticle = true;
  setTimeout(() => saveNow(), 0);
}
// Suppléments payants (version 3.5.3) : groupe d'options « Supplément », affiché comme un commentaire
// sur la ligne (« SUPPLEMENT Frites (500 DA) ») et ajouté au prix du plat. Branché sur tous les plats cuisine/asiatique.
if (!db.supp1) {
  let g = db.options.find(o => o.id === 'supplements');
  if (!g) { g = { id: 'supplements', nom: 'Supplément', obligatoire: false, multiple: true, choix: [] }; db.options.push(g); }
  if (!g.choix.some(ch => /^frites$/i.test(ch.nom))) g.choix.push({ nom: 'Frites', prix: 500 });
  const cuisines = new Set(db.categories.filter(k => ['cuisine', 'cuisine2', 'asiatique'].includes(k.poste)).map(k => k.id));
  for (const p of db.produits) if (cuisines.has(p.cat)) { p.options = p.options || []; if (!p.options.includes('supplements')) p.options.push('supplements'); }
  db.supp1 = true;
}
// Groupe « Suppléments » (version 3.5.7) : l'article Supplément n'est plus compté dans « Brunch œufs »
if (!db.supp4) {
  const sp = db.produits.find(p => p.id === 'supplement-fixe');
  if (sp) {
    let cat = db.categories.find(c => c.id === 'supplements');
    if (!cat) {
      const ref = db.categories.find(c => c.id === sp.cat) || {};
      cat = { id: 'supplements', nom: 'Suppléments', poste: ref.poste || 'cuisine', couleur: '#f3e6c4', suite: ref.suite || 2, univers: 'La carte', ordre: db.categories.length };
      db.categories.push(cat);
    }
    sp.cat = cat.id;
  }
  db.supp4 = true;
  setTimeout(() => saveNow(), 0);
}
// Les lignes déjà vendues conservent leurs options. Les nouvelles utilisent l'article libre.
function retirerOptionsSupplement() {
  db.options = db.options.filter(g => g.id !== 'supplements');
  for (const p of db.produits) p.options = (p.options || []).filter(g => g !== 'supplements');
}
// Code imposé (version 3.5.7) : Wafi, caissier, 1009
if (!db.equipe5) {
  let u = db.users.find(x => x.nom.toLowerCase() === 'wafi');
  if (!u) { u = { id: 'u-wafi', nom: 'Wafi', role: 'caissier', pin: '', badge: '', actif: true }; db.users.push(u); }
  for (const o of db.users) if (o !== u && o.pin === '1009') { let c; do c = String(1000 + Math.floor(Math.random() * 9000)); while (db.users.some(x => x.pin === c) || ['2000', '1993', '1996', '1515', '1009'].includes(c)); o.pin = c; }
  u.pin = '1009'; u.role = 'caissier'; u.actif = true;
  db.equipe5 = true;
  setTimeout(() => saveNow(), 0);
}
// Version 3.5.6 (demandes du gérant) :
// - suppléments Gruyère et Parmesan (500 DA) dans le groupe d'options « Supplément »
// - sociétés payées sur facture (mêmes noms que l'appli de gestion)
// - rase automatique de nuit ACTIVÉE à 2h avec extinction du PC (le gérant veut que le système soit éteint vers 2h)
if (!db.supp3) {
  const g = db.options.find(o => o.id === 'supplements');
  if (g) for (const nom of ['Gruyère', 'Parmesan']) if (!g.choix.some(ch => ch.nom.toLowerCase() === nom.toLowerCase())) g.choix.push({ nom, prix: 500 });
  db.config.societes = db.config.societes || [];
  for (const soc of ['SPA SGS QUALITEST ALGERIE', 'ALGERIENNE VIE', 'SPA FRERES RAHMOUNE DISMAC', 'SPA SARPI'])
    if (!db.config.societes.some(x => x.trim().toUpperCase() === soc)) db.config.societes.push(soc);
  db.config.raseAuto = { ...(db.config.raseAuto || {}), actif: true, heure: (db.config.raseAuto || {}).heure || '02:00', extinction: false };
  db.supp3 = true;
  setTimeout(() => saveNow(), 0);
}
if (!db.supplementLibreUnique) {
  retirerOptionsSupplement();
  db.supplementLibreUnique = true;
}

// Carte complétée avec le site (version 3.3.1) : sushis, rolls, lattes, desserts de la carte. Rien n'est supprimé ni modifié.
if (!db.carte2) {
  const A = {"cats": [["sushis-a-partager", "Sushis à partager", "asiatique", "#f6d6c8", 1, "Asiatique", "asiatique-box", -0.2], ["rolls", "Rolls", "asiatique", "#d6e6f2", 2, "Asiatique", "asiatique-box", -0.1], ["lattes", "Lattes (chauds ou glacés)", "comptoir", "#e8d5c0", 0, "Boissons", "boissons", 0.5]], "prods": [["sushis-a-partager", [["Nems au poulet × 3", 1700], ["Gyoza au poulet × 5", 2200], ["Soupe de gyoza", 2400], ["Crispy rice tempura × 5", 2300], ["Crispy rice avocat × 5", 2400], ["Futomaki × 10", 2500], ["Maki avocat × 12", 1800], ["Maki saumon × 12", 2200], ["Nigiri saumon × 3", 1800]]], ["rolls", [["California saumon avocat × 8", 2400], ["Dragon saumon roll × 8", 2600], ["Rainbow roll × 8", 2800], ["Crunchy saumon roll × 8", 2600], ["Crunchy poulet roll × 8", 2400], ["Flamed roll × 8", 2800], ["Creamy avocado roll × 8", 2400], ["Veggie roll × 8", 2500], ["Maki crispy tartare saumon × 6", 1800], ["Crunch tempura × 8", 2800]]], ["lattes", [["Latte vanille", 750], ["Latte caramel beurre salé", 750], ["Matcha latte vanille", 900], ["Matcha latte fraise", 900], ["Matcha latte pistache", 1000], ["Macchiato", 500], ["Tiramisu latte", 1000], ["Matcha tiramisu latte", 1100]]], ["desserts", [["Profiteroles chocolat", 1200], ["Pavlova", 1000], ["Crème brûlée", 1000], ["Fondant chocolat glace", 1000], ["Nougat glacé fruits rouges", 1200]]]]};
  const n = x => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  for (const [id, nom, poste, couleur, suite, univers, apres, decal] of A.cats) {
    if (db.categories.some(c => c.id === id)) continue;
    const ref = db.categories.find(c => c.id === apres);
    db.categories.push({ id, nom, poste: db.config.imprimantes[poste] ? poste : 'cuisine', couleur, suite, univers, ordre: (ref ? ref.ordre : db.categories.length) + decal });
  }
  db.categories.sort((a, b) => a.ordre - b.ordre).forEach((c, i) => (c.ordre = i));
  for (const [cat, items] of A.prods) {
    if (!db.categories.some(c => c.id === cat)) continue;
    for (const [nom, prix] of items) {
      if (db.produits.some(p => n(p.nom) === n(nom))) continue;
      db.seq.produit = (db.seq.produit || 0) + 1;
      db.produits.push({ id: 'ps' + Date.now().toString(36) + db.seq.produit, nom, prix, cat, actif: true, options: [], stock: null });
    }
  }
  db.carte2 = true;
  setTimeout(() => saveNow(), 0);
}
// version 3.3.2 : nom à jour (carte du site) et plat de FrontCash manquant
if (!db.carte3) {
  const t = db.produits.find(p => p.nom === 'Tagliatelles saumon fumé'); if (t) t.nom = 'Rigatoni au saumon';
  if (db.categories.some(c => c.id === 'entrees-chaudes') && !db.produits.some(p => /cromesquis/i.test(p.nom)))
    db.produits.push({ id: 'ps-cromesquis', nom: 'Cromesquis d\'escargots', prix: 2400, cat: 'entrees-chaudes', actif: true, options: [], stock: null });
  db.carte3 = true;
  setTimeout(() => saveNow(), 0);
}
for (const s of db.config.salles) {
  if (s.tables.length && typeof s.tables[0] === 'string') s.tables = s.tables.map((n, i) => ({ n, x: 8 + (i % 10) * 9.5, y: 12 + Math.floor(i / 10) * 20 }));
  s.deco = s.deco || []; s.fond = s.fond || 'creme'; s.ratio = s.ratio || 1.6; s.taille = s.taille || 7;
}

// Prix alignés sur le site lamaisonblanchehydra.com (version 3.6.0, demande du gérant : le site fait foi).
// Correspondance par nom d'article (les identifiants diffèrent d'une caisse à l'autre). Chaque changement est noté au journal.
if (!db.prixSite6) {
  const SITE = [["Œuf à la turque",1500],["Œuf Benedict",2000],["Toast avocat saumon",2600],["Club sandwich saumon fumé",2700],["Club sandwich poulet fumé",2200],["Croissant croque-monsieur",2000],["Long toast tunacado",2500],["Salade César",1600],["Crêpe salée poulet, épinard",1500],["Sandwich La Maison Blanche",2300],["Sandwich salade César",1700],["Burger bœuf",2000],["Burger poulet crispy",1800],["Cake fondant caramel",1500],["Hot cookie",1600],["Brioche perdue tiramisu",1500],["Brioche perdue caramel",2000],["NY roll citron meringué",1000],["NY roll pistache",1200],["Crêpe Suzette glace vanille",1600],["Matilda cake",1000],["Pancake beurre miel",1000],["Gaufre Nutella",1500],["Gaufre pistache",1500],["Crêpe Nutella",1500],["Crêpe pistache",1500],["Tiramisu",1000],["Meringue lemon cake",1000],["Granola bowl",1800],["Carpaccio de bœuf",2500],["Burrata, carpaccio de tomates",2000],["Salade grecque",2200],["Salade de quinoa aux crustacés",2800],["Médaillon de foie gras",3300],["Soupe du jour",1800],["Soupe aux fruits de mer",2400],["Boureks × 2",800],["Escargots de Bourgogne",2300],["Tarte aux crevettes",2700],["Saint-Jacques, pommes vertes",3300],["Duo calamars crevettes à l'ail",2800],["Gambas tempura",3200],["Moules frites",2100],["Cœur de filet, sauce morilles",4500],["Côte de bœuf (2 pers.)",9000],["Méchoui d'agneau",5000],["Souris d'agneau confite",4500],["Entrecôte poivre vert",3200],["Saumon à l'orange",4500],["Daurade aux crustacés",3700],["Loup de mer",3700],["Ballotine de poulet au saumon",3000],["Magret de canard au cassis",4500],["Blanquette exotique MB",3000],["Raviolis ricotta épinards",2600],["Rigatoni au saumon",2800],["Tagliatelles poulet champignons",2400],["Linguine alla scoglio",4500],["Spaghettis moules pesto",2800],["Profiteroles chocolat",1200],["Pavlova",1000],["Crème brûlée",1000],["Fondant chocolat glace",1000],["Tiramisu",1000],["Nougat glacé fruits rouges",1200],["Meringue lemon cake",1000],["Nems au poulet × 3",1700],["Gyoza au poulet × 5",2200],["Soupe de gyoza",2400],["Crispy rice tempura × 5",2300],["Crispy rice avocat × 5",2400],["Futomaki × 10",2500],["Maki avocat × 12",1800],["Maki saumon × 12",2200],["Nigiri saumon × 3",1800],["California saumon avocat × 8",2400],["Dragon saumon roll × 8",2600],["Rainbow roll × 8",2800],["Crunchy saumon roll × 8",2600],["Crunchy poulet roll × 8",2400],["Flamed roll × 8",2800],["Creamy avocado roll × 8",2400],["Veggie roll × 8",2500],["Maki crispy tartare saumon × 6",1800],["Crunch tempura × 8",2800],["Duo signature × 24",5400],["Party box × 54",14200],["Poke bowl",3200],["Wok au poulet",2400],["Ramen gyoza",2500],["Ramen aux crevettes",3200],["Taco crispy",3100],["Mochis glacés × 2",2000],["Eau minérale GM",200],["Eau pétillante GM",200],["Coca",250],["Coca zéro",250],["Selecto",250],["Hamoud blanche",250],["Sprite",250],["Schweppes",250],["Café",400],["Cappuccino",500],["Chocolat chaud",700],["Thé",400],["Infusion",400],["Latte vanille",750],["Latte caramel beurre salé",750],["Matcha latte vanille",900],["Matcha latte fraise",900],["Matcha latte pistache",1000],["Macchiato",500],["Tiramisu latte",1000],["Matcha tiramisu latte",1100],["Parfum des femmes",650],["Exotic passion",750],["Exotic mango",750],["Exotic fruits rouges",750],["Mojito classique",650],["Mojito fraise",750],["Piña colada",700],["Ice tea pêche",700],["Ice tea fruits des bois",700],["Cocktail Maison Blanche",1000],["Detox ananas pomme menthe",700],["Detox orange carotte dattes",800],["Detox pomme gingembre coco",800],["Jus d'orange",500],["Jus de citron",500],["Jus de mangue",900],["Jus de fraise",700],["Smoothie pistachio kunafa",1100],["Smoothie peanut butter",1100]];
  const n = x => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const changes = [];
  for (const [nom, prix] of SITE) for (const p of db.produits.filter(x => n(x.nom) === n(nom))) if (p.prix !== prix) { changes.push(p.nom + ' ' + p.prix + ' → ' + prix); p.prix = prix; }
  if (changes.length) db.journal.push({ ts: Date.now(), user: '-', action: 'prix alignés sur le site', detail: changes.join(' ; ') });
  db.prixSite6 = { ts: Date.now(), changes };
  setTimeout(() => saveNow(), 0);
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 150);
  broadcast();
}
function saveNow() {
  const limite = Date.now() - 60 * 864e5;
  if (db.bons.length > 5000) db.bons = db.bons.filter(b => b.ts > limite);
  const tmp = DB_FILE + '.tmp';
  const data = JSON.stringify(db);
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, DB_FILE);
  const b = path.join(BACKUPS, 'caisse-' + dateLocale(Date.now()) + '.json');
  if (!fs.existsSync(b)) {
    fs.copyFileSync(DB_FILE, b);
    const all = fs.readdirSync(BACKUPS).filter(f => f.endsWith('.json')).sort();
    while (all.length > 90) fs.unlinkSync(path.join(BACKUPS, all.shift()));
  }
}
saveNow();
process.on('SIGINT', () => { saveNow(); process.exit(0); });
process.on('SIGTERM', () => { saveNow(); process.exit(0); });

const now = () => Date.now();
function journal(user, action, detail) { db.journal.push({ ts: now(), user: user ? user.nom : '-', action, detail }); if (db.journal.length > 20000) db.journal.splice(0, 5000); }
function dateLocale(ts) { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

// Journée de caisse : s'ouvre à la première vente, se ferme à la rase
function jourCourant(creer) {
  let j = db.jours.find(x => !x.clos);
  if (!j && creer) {
    db.seq.jour++;
    j = { id: 'J' + db.seq.jour, n: db.seq.jour, date: dateLocale(now()), ouvert: now(), clos: null, rase: null };
    db.jours.push(j);
  }
  return j;
}

// ---------------------------------------------------------------- Sessions
const sessions = new Map(); // token -> {userId, ts, created}
const SESSION_IDLE_MS = 2 * 3600000, SESSION_MAX_MS = 12 * 3600000;
// Les connexions sont gardées sur disque : une mise à jour (redémarrage du serveur) ne déconnecte plus les écrans (3.5.7)
const SESSIONS_FILE = path.join(DATA, 'sessions.json');
try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')))) if (Date.now() - v.ts < SESSION_IDLE_MS && Date.now() - (v.created || v.ts) < SESSION_MAX_MS) sessions.set(k, v); } catch (e) {}
function sauverSessions() { try { fs.writeFileSync(SESSIONS_FILE + '.tmp', JSON.stringify(Object.fromEntries(sessions))); fs.renameSync(SESSIONS_FILE + '.tmp', SESSIONS_FILE); } catch (e) {} }
setInterval(sauverSessions, 30000);
const essaisAcces = new Map();
function controleEssais(req) {
  const ip = String(req?.socket?.remoteAddress || 'inconnue');
  const t = now(), x = essaisAcces.get(ip);
  if (x && x.bloqueJusqua > t) E('Trop de tentatives. Réessayez dans quelques minutes.', 429);
  if (essaisAcces.size > 2000) for (const [k, v] of essaisAcces) if (t - v.debut > 3600000) essaisAcces.delete(k);
  return ip;
}
function echecAcces(ip) {
  const t = now(), ancien = essaisAcces.get(ip);
  const x = ancien && t - ancien.debut < 5 * 60000 ? ancien : { debut: t, n: 0, bloqueJusqua: 0 };
  x.n++;
  if (x.n >= 5) x.bloqueJusqua = t + 5 * 60000;
  essaisAcces.set(ip, x);
}
function succesAcces(ip) { essaisAcces.delete(ip); }
function userDe(req) {
  const t = req.headers['x-token'];
  const s = t && sessions.get(t);
  if (!s) return null;
  if (now() - s.ts > SESSION_IDLE_MS || now() - (s.created || s.ts) > SESSION_MAX_MS) { sessions.delete(t); return null; }
  const u = db.users.find(x => x.id === s.userId && x.actif);
  if (!u) return null;
  s.ts = now();
  return u;
}
// un code OU un badge (lecteur de cartes) identifie la personne
function parCode(code) { code = String(code || '').trim(); if (!code) return null; return db.users.find(u => u.actif && (u.pin === code || (u.badge && u.badge === code))); }
function pinAdmin(pin) { const u = parCode(pin); return u && u.role === 'admin' ? u : null; }
const ROLES = { cuisine: 0, serveur: 1, caissier: 2, admin: 3 };
function peut(u, role) { return u && ROLES[u.role] >= ROLES[role]; }

// ---------------------------------------------------------------- Impression ESC/POS
const ESC = 0x1b, GS = 0x1d;
const CP1252 = { 'œ': 0x9c, 'Œ': 0x8c, '€': 0x80, '’': 0x27, '‘': 0x27, '“': 0x22, '”': 0x22, '–': 0x2d, '—': 0x2d, '…': 0x2e, ' ': 0x20, ' ': 0x20 };
function enc(str) {
  const cfg = db.config;
  if (cfg.sansAccents) str = str.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/œ/g, 'oe').replace(/Œ/g, 'OE');
  const out = [];
  for (const ch of str) {
    if (CP1252[ch] !== undefined) out.push(CP1252[ch]);
    else { const c = ch.codePointAt(0); out.push(c < 256 ? c : 0x3f); }
  }
  return Buffer.from(out);
}
let LOGO = null; try { LOGO = fs.readFileSync(path.join(DIR, 'logo-ticket.bin')); } catch (e) {}
class Doc {
  constructor() { this.parts = [Buffer.from([ESC, 0x40, ESC, 0x74, db.config.pageCode || 16])]; this.w = db.config.largeur || 48; this.txt = []; }
  raw(...b) { this.parts.push(Buffer.from(b)); return this; }
  t(s) { this.parts.push(enc(s + '\n')); this.txt.push(s); return this; }
  center(on) { return this.raw(ESC, 0x61, on ? 1 : 0); }
  bold(on) { return this.raw(ESC, 0x45, on ? 1 : 0); }
  size(n) { return this.raw(GS, 0x21, n === 2 ? 0x11 : n === 3 ? 0x01 : 0); } // 2 = double, 3 = double hauteur
  line(ch = '-') { return this.t(ch.repeat(this.w)); }
  lr(a, b, w) { w = w || this.w; a = String(a); b = String(b); const sp = w - a.length - b.length; if (sp >= 1) return this.t(a + ' '.repeat(sp) + b); return this.t(a.slice(0, w - b.length - 1) + ' ' + b); }
  feed(n = 4) { return this.raw(ESC, 0x64, n); }
  cut() { this.feed(4); return this.raw(GS, 0x56, 66, 0); }
  drawer() { return this.raw(ESC, 0x70, 0, 25, 250); }
  // QR code imprimé par l'imprimante elle-même (commande ESC/POS standard Epson)
  qr(texte, taille = 6) {
    const data = Buffer.from(String(texte), 'utf8'), n = data.length + 3;
    this.raw(GS, 0x28, 0x6b, 4, 0, 49, 65, 50, 0).raw(GS, 0x28, 0x6b, 3, 0, 49, 67, taille).raw(GS, 0x28, 0x6b, 3, 0, 49, 69, 49);
    this.parts.push(Buffer.from([GS, 0x28, 0x6b, n & 255, n >> 8, 49, 80, 48]), data);
    this.raw(GS, 0x28, 0x6b, 3, 0, 49, 81, 48);
    this.txt.push('[QR : ' + texte + ']');
    return this;
  }
  // logo de La Maison Blanche (image noir et blanc)
  logo() {
    if (!LOGO) return this;
    const wb = LOGO[0] | (LOGO[1] << 8), h = LOGO[2] | (LOGO[3] << 8);
    this.parts.push(Buffer.from([GS, 0x76, 0x30, 0, wb & 255, wb >> 8, h & 255, h >> 8]), LOGO.subarray(4));
    this.txt.push('[LOGO]');
    return this;
  }
  buf() { return Buffer.concat(this.parts); }
  texte() { return this.txt.join('\n') + '\n'; }
}
// Imprimante branchée en USB sur ce PC : envoi par le spouleur Windows (données brutes ESC/POS)
let fileUSB = Promise.resolve();
function imprimerUSB(p, buf) {
  const travail = () => new Promise(resolve => {
    if (process.platform !== 'win32') return resolve({ ok: false, erreur: 'Impression USB possible seulement sur le PC Windows de la caisse' });
    const f = path.join(os.tmpdir(), 'mb-ticket-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.bin');
    fs.writeFileSync(f, buf);
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(DIR, 'impression-usb.ps1'), '-Printer', p.windows, '-File', f],
      { timeout: 25000, windowsHide: true }, (err, out, errOut) => {
        try { fs.unlinkSync(f); } catch (e) {}
        const r = String(out || '').trim();
        if (r.endsWith('OK')) return resolve({ ok: true });
        const raison = r.includes('introuvable') ? 'introuvable dans Windows (vérifiez son nom)' : r.includes('ERR') ? r.replace(/^.*ERR /s, 'erreur ') : (err ? err.message.split('\n')[0] : String(errOut || '').split('\n')[0]);
        resolve({ ok: false, erreur: 'Imprimante ' + p.nom + ' (USB « ' + p.windows + ' ») : ' + raison });
      });
  });
  const r = fileUSB.then(travail);
  fileUSB = r.catch(() => {});
  return r;
}
function imprimantesWindows() {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve([]);
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Printer | ForEach-Object { $_.Name }'], { timeout: 20000, windowsHide: true },
      (err, out) => resolve(String(out || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean)));
  });
}
function imprimer(poste, doc) {
  const p = db.config.imprimantes[poste];
  if (p && p.type === 'usb' && p.windows) return imprimerUSB(p, doc.buf());
  return new Promise((resolve) => {
    if (!p || !p.ip) {
      const f = path.join(PRINTS, new Date().toISOString().replace(/[:.]/g, '-') + '-' + poste + '.txt');
      fs.writeFileSync(f, doc.texte(), 'utf8');
      return resolve({ ok: true, simule: true });
    }
    const sock = net.connect({ host: p.ip, port: +p.port || 9100 });
    let fini = false;
    const fin = (r) => { if (fini) return; fini = true; try { sock.destroy(); } catch (e) {} resolve(r); };
    sock.setTimeout(5000, () => fin({ ok: false, erreur: 'Imprimante ' + p.nom + ' (' + p.ip + ') ne répond pas' }));
    sock.on('error', (e) => fin({ ok: false, erreur: 'Imprimante ' + p.nom + ' (' + p.ip + ') : ' + e.code }));
    sock.on('connect', () => sock.end(doc.buf(), () => setTimeout(() => fin({ ok: true }), 200)));
  });
}
const fmt = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const heure = ts => new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const dateH = ts => new Date(ts).toLocaleDateString('fr-FR') + ' ' + heure(ts);
function salleNom(id) { const s = db.config.salles.find(x => x.id === id); return s ? s.nom : (id === 'comptoir' ? 'Comptoir' : id === 'emporter' ? 'À emporter' : id); }
// titre d'une commande sur les bons : « TABLE 7 » ou « À EMPORTER E3 »
function titreCmd(c) { return c.salle === 'emporter' ? 'À EMPORTER ' + c.table : c.salle === 'comptoir' ? 'COMPTOIR' : 'TABLE ' + c.table; }
function infosEmporter(d, c) {
  if (c.salle !== 'emporter') return;
  if (c.client && c.client.nom) d.bold(1).t('Client : ' + c.client.nom + (c.client.tel ? '  ' + c.client.tel : '')).bold(0);
  d.bold(1).t('Retrait : ' + (c.retrait ? heure(c.retrait) : 'dès que possible')).bold(0);
}
function nomUser(id) { const u = db.users.find(x => x.id === id); return u ? u.nom : '-'; }
function postesBons() { return Object.keys(db.config.imprimantes).filter(k => k !== 'ticket'); }
function posteDe(pid) {
  const p = db.produits.find(x => x.id === pid); const c = p && db.categories.find(x => x.id === p.cat);
  const k = c ? c.poste : 'cuisine';
  return db.config.imprimantes[k] && k !== 'ticket' ? k : postesBons()[0];
}
// Article « partout » (3.3.6) : le bon sort sur toutes les imprimantes de bons branchées (IP ou USB)
function postesDe(pid) {
  const p = db.produits.find(x => x.id === pid);
  if (p && p.partout) {
    const reels = postesBons().filter(k => { const i = db.config.imprimantes[k]; return i && (i.ip || (i.type === 'usb' && i.windows)); });
    const l = reels.length ? reels : postesBons().filter(k => k !== 'cuisine2');
    if (l.length) return l;
  }
  // article envoyé sur plusieurs imprimantes choisies (3.3.8), ex. Fondant : cuisine + comptoir
  if (p && Array.isArray(p.postes)) { const l = p.postes.filter(k => db.config.imprimantes[k] && k !== 'ticket'); if (l.length) return l; }
  return [posteDe(pid)];
}
const MODES = { especes: 'Espèces', cheque: 'Chèque', tpe: 'Carte (TPE)', societe: 'Sur facture', offert: 'Offert', mixte: 'Plusieurs modes' };

// libellé d'une option sur les bons et tickets : les suppléments montrent leur prix
const estSupp = o => o.g === 'supplements';
const optBon = o => estSupp(o) ? 'SUPPLEMENT ' + o.nom + (o.prix ? ' (' + fmt(o.prix) + ' DA)' : '') : o.nom + (o.prix ? ' (+' + fmt(o.prix) + ' DA)' : '');
function lignesBon(d, l) {
  d.size(3).bold(1).t(l.qte + '  ' + l.nom).bold(0).size(0);
  for (const o of l.opts || []) d.bold(1).t('    + ' + optBon(o)).bold(0);
  if (l.emporter) d.bold(1).t('    *** A EMPORTER ***').bold(0);
  if (l.note) d.bold(1).t('    >> ' + l.note).bold(0);
}
function bon(poste, cmd, lignes, titre, infos) {
  const d = new Doc();
  d.center(1).size(2).bold(1).t(((db.config.imprimantes[poste] || {}).nom || poste).toUpperCase()).size(0);
  if (titre) for (const ligne of String(titre).split('\n')) d.t(ligne);
  d.bold(0).center(0).line('=');
  d.size(2).bold(1).t(titreCmd(cmd)).size(0).bold(0);
  if (cmd.salle === 'emporter') infosEmporter(d, cmd); else d.t(salleNom(cmd.salle) + ' - ' + (cmd.couverts || '?') + ' couv.');
  d.t('Serveur : ' + nomUser(cmd.serveurId) + '   ' + heure(now()));
  if (cmd.note) d.bold(1).t('NOTE : ' + cmd.note).bold(0);
  d.line();
  const suites = [...new Set(lignes.map(l => l.suite || 0))].sort((a, b) => a - b);
  for (const s of suites) {
    const attente = s > (cmd.suite || 0) && s > 0;
    if (suites.length > 1 || attente) d.center(1).bold(1).t('--- ' + SUITES[s].toUpperCase() + (attente ? ' : ATTENDRE LA RÉCLAME' : '') + ' ---').bold(0).center(0);
    for (const l of lignes.filter(l => (l.suite || 0) === s)) lignesBon(d, l);
  }
  // commande commune asiatique + gastro/brunch : la partie de l'autre cuisine, pour information
  for (const [autre, ls] of Object.entries(infos || {})) {
    d.line('-').center(1).bold(1).t('POUR INFO - FAIT PAR ' + ((db.config.imprimantes[autre] || {}).nom || autre).toUpperCase()).bold(0).center(0);
    for (const l of ls) { d.t(l.qte + '  ' + l.nom + (l.suite > (cmd.suite || 0) ? ' (' + SUITES[l.suite] + ', attendre)' : '')); for (const o of l.opts || []) d.t('    + ' + optBon(o)); }
  }
  d.line();
  d.cut();
  return d;
}
// Écran cuisine : un bon par poste et par suite
function creerBons(c, lignes, type) {
  const parPoste = {};
  for (const l of lignes) for (const k of postesDe(l.pid)) (parPoste[k] = parPoste[k] || []).push(l);
  for (const [poste, ls] of Object.entries(parPoste)) {
    const suites = [...new Set(ls.map(l => l.suite || 0))];
    for (const s of suites) {
      db.seq.bon++;
      db.bons.push({ id: 'B' + db.seq.bon, cmdId: c.id, salle: c.salle, table: c.table, serveurId: c.serveurId, poste, ts: now(), suite: s, type: type || 'commande',
        etat: s > (c.suite || 0) && s > 0 ? 'attente' : 'a_faire',
        lignes: ls.filter(l => (l.suite || 0) === s).map(l => ({ id: l.id, qte: l.qte, nom: l.nom, opts: (l.opts || []).map(o => typeof o === 'string' ? o : optBon(o)), note: l.note, emporter: !!l.emporter })) });
    }
  }
}
function enteteTicket(d) {
  const c = db.config;
  d.center(1);
  if (c.logoTicket !== false && LOGO) d.logo().t(''); else d.size(2).bold(1).t(c.nom.toUpperCase()).size(0).bold(0);
  d.t(c.adresse).t('Tel ' + c.tel).center(0).line();
}
function piedTicket(d) {
  const c = db.config;
  d.line().center(1).bold(1).t(c.piedTicket).bold(0);
  if (c.qrLien) { d.t(''); d.qr(c.qrLien); if (c.qrTexte) d.t(c.qrTexte); }
  d.center(0);
}
function lignesTicket(d, lignes, sansPayees) {
  const grp = {};
  for (const l of lignes) { if (l.annule || (sansPayees && l.paye)) continue; const o = (l.opts || []).filter(x => x.prix).map(x => (estSupp(x) ? 'Supplément ' : '') + x.nom + ' ' + fmt(x.prix)).join(', '); const k = l.nom + '|' + o + '|' + l.prix + '|' + (l.offert ? 1 : 0); (grp[k] = grp[k] || { ...l, o, qte: 0 }).qte += l.qte; }
  for (const l of Object.values(grp)) { d.lr(l.qte + ' x ' + l.nom, l.offert ? 'OFFERT' : fmt(l.qte * l.prix)); if (l.o) d.t('    + ' + l.o); }
}
// paiements d'un ticket (les anciens tickets n'ont qu'un mode)
function paiementsDe(t) { return t.paiements || [{ mode: t.mode, montant: t.mode === 'offert' ? 0 : t.net, societe: t.societe, reference: t.reference }]; }
const sommeMode = (tks, m) => tks.reduce((s, t) => s + paiementsDe(t).filter(p => p.mode === m).reduce((a, p) => a + p.montant, 0), 0);
function ticketDoc(tk, duplicata) {
  const d = new Doc();
  enteteTicket(d);
  if (duplicata) d.center(1).bold(1).t('*** DUPLICATA ***').bold(0).center(0);
  d.t('Ticket n° ' + tk.num + '   ' + dateH(tk.ts));
  if (tk.salle === 'emporter') d.bold(1).t('A EMPORTER ' + tk.table + (tk.client && tk.client.nom ? ' - ' + tk.client.nom : '')).bold(0);
  else d.t(salleNom(tk.salle) + ' - Table ' + tk.table + ' - ' + (tk.couverts || 1) + ' couv.');
  d.t('Serveur : ' + tk.serveur + '   Caisse : ' + tk.caissier);
  d.line();
  lignesTicket(d, tk.lignes);
  d.line();
  if (tk.remise > 0) { d.lr('Sous-total', fmt(tk.total) + ' DA'); d.lr('Remise', '-' + fmt(tk.remise) + ' DA'); }
  d.size(2).bold(1).lr('TOTAL', fmt(tk.net) + ' DA', Math.floor(d.w / 2)).size(0).bold(0);
  if (tk.partiel) d.t('Paiement partiel de la table');
  if (tk.mode === 'offert') d.t('Offert - ' + (tk.motif || ''));
  else for (const p of paiementsDe(tk)) d.lr(MODES[p.mode] + (p.mode === 'societe' ? ' ' + p.societe : '') + (p.reference ? ' n° ' + p.reference : ''), fmt(p.montant) + ' DA');
  if (tk.recu && tk.rendu > 0) { d.lr('Espèces reçues', fmt(tk.recu) + ' DA'); d.lr('Rendu', fmt(tk.rendu) + ' DA'); }
  if (paiementsDe(tk).some(p => p.mode === 'societe')) d.line().t('Bon pour facture').t('Nom et signature du client :').feed(3).t('Cachet de la société :').feed(3);
  piedTicket(d);
  d.cut();
  return d;
}
function additionDoc(cmd) {
  const d = new Doc();
  enteteTicket(d);
  d.center(1).bold(1).t('ADDITION').bold(0).center(0);
  d.t((cmd.salle === 'emporter' ? 'A emporter ' + cmd.table + (cmd.client && cmd.client.nom ? ' - ' + cmd.client.nom : '') : salleNom(cmd.salle) + ' - Table ' + cmd.table) + '   ' + dateH(now()));
  d.t('Serveur : ' + nomUser(cmd.serveurId));
  d.line();
  lignesTicket(d, cmd.lignes, true);
  d.line();
  if (cmd.lignes.some(l => l.paye)) d.t('(articles déjà réglés non repris)');
  d.size(2).bold(1).lr('TOTAL', fmt(totalCmd(cmd)) + ' DA', Math.floor(d.w / 2)).size(0).bold(0);
  if (cmd.couverts > 1) d.lr('Soit par personne (' + cmd.couverts + ')', fmt(totalCmd(cmd) / cmd.couverts) + ' DA');
  d.center(1).t('Ceci n\'est pas un ticket de caisse').center(0);
  piedTicket(d);
  d.cut();
  return d;
}
function totalCmd(cmd) { return cmd.lignes.reduce((s, l) => s + (l.annule || l.offert || l.paye ? 0 : l.qte * l.prix), 0); }

// tables ouvertes sans rien à payer : fermées à la rase (version 3.5.7)
function fermerTablesVides(qui) {
  let n = 0;
  for (const c of Object.values(db.commandes)) if (c.statut === 'ouverte' && !c.lignes.some(l => !l.annule && !l.paye)) { c.statut = 'annulee'; c.ferme = now(); n++; }
  if (n) journal(qui, 'tables vides fermées', n + ' table(s)');
  return n;
}
// ---------------------------------------------------------------- Calculs journée
function resumeJour(j) {
  if (!j) return null;
  const tks = db.tickets.filter(t => t.jour === j.id && !t.annule);
  const sorties = db.sorties.filter(s => s.jour === j.id);
  const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
  const especes = sommeMode(tks, 'especes'), societe = sommeMode(tks, 'societe'), cheque = sommeMode(tks, 'cheque'), tpe = sommeMode(tks, 'tpe');
  const offert = sum(tks.filter(t => t.mode === 'offert'), t => t.total);
  const totalSorties = sum(sorties, s => s.montant);
  const parServeur = {}, parCaissier = {};
  for (const t of tks) { if (t.mode === 'offert') continue; parServeur[t.serveur] = (parServeur[t.serveur] || 0) + t.net; parCaissier[t.caissier] = (parCaissier[t.caissier] || 0) + t.net; }
  const annulations = [];
  for (const c of Object.values(db.commandes)) if (c.jour === j.id) for (const l of c.lignes) if (l.annule && l.envoye) annulations.push({ table: c.table, nom: l.nom, qte: l.qte, montant: l.qte * l.prix, motif: l.annule.motif, par: l.annule.par });
  // table « ouverte » = il reste des articles à payer (une table ouverte puis laissée vide ne bloque plus la rase)
  const ouvertes = Object.values(db.commandes).filter(c => c.statut === 'ouverte' && c.lignes.some(l => !l.annule && !l.paye));
  return {
    jour: j, nbTickets: tks.length, ca: especes + cheque + tpe + societe, especes, cheque, tpe, societe, offert,
    remises: sum(tks, t => t.remise || 0), patron: sum(tks.filter(t => t.patron), t => t.net),
    couverts: sum(tks, t => t.couverts || 0),
    sorties, totalSorties, fondCaisse: db.config.fondCaisse,
    attenduTiroir: db.config.fondCaisse + especes - totalSorties,
    aRemettre: especes - totalSorties,
    parServeur, parCaissier, annulations,
    totalAnnulations: sum(annulations, a => a.montant),
    tablesOuvertes: ouvertes.length, montantOuvert: sum(ouvertes, totalCmd),
  };
}
function rapport(du, au) {
  const tks = db.tickets.filter(t => !t.annule && t.date >= du && t.date <= au);
  const plats = {}, cats = {}, jours = {}, serveurs = {}, heures = {}, parSociete = {};
  let ca = 0, especes = 0, cheque = 0, tpe = 0, societe = 0, offert = 0, remises = 0, couverts = 0;
  for (const t of tks) {
    if (t.mode !== 'offert') { ca += t.net; jours[t.date] = (jours[t.date] || 0) + t.net; serveurs[t.serveur] = (serveurs[t.serveur] || 0) + t.net; const h = new Date(t.ts).getHours(); heures[h] = (heures[h] || 0) + t.net; }
    if (t.mode === 'offert') offert += t.total;
    for (const p of paiementsDe(t)) { if (p.mode === 'especes') especes += p.montant; else if (p.mode === 'cheque') cheque += p.montant; else if (p.mode === 'tpe') tpe += p.montant; else if (p.mode === 'societe') { societe += p.montant; const k = p.societe || 'Société ?'; const x = parSociete[k] = parSociete[k] || { nom: k, montant: 0, tickets: [] }; x.montant += p.montant; x.tickets.push({ num: t.num, date: t.date, montant: p.montant }); } }
    remises += t.remise || 0; couverts += t.couverts || 0;
    for (const l of t.lignes) {
      if (l.annule) continue;
      const p = plats[l.nom] = plats[l.nom] || { nom: l.nom, cat: l.catNom || '', qte: 0, montant: 0 };
      p.qte += l.qte; p.montant += l.offert ? 0 : l.qte * l.prix;
      const cn = l.catNom || 'Autre'; cats[cn] = (cats[cn] || 0) + (l.offert ? 0 : l.qte * l.prix);
    }
  }
  const sorties = db.sorties.filter(s => s.date >= du && s.date <= au);
  // période précédente de même durée, pour comparer
  const j0 = new Date(du + 'T12:00'), j1 = new Date(au + 'T12:00'), n = Math.round((j1 - j0) / 864e5) + 1;
  const pd = new Date(j0); pd.setDate(pd.getDate() - n); const pa = new Date(j0); pa.setDate(pa.getDate() - 1);
  const pdu = dateLocale(pd.getTime()), pau = dateLocale(pa.getTime());
  const precedent = db.tickets.filter(t => !t.annule && t.mode !== 'offert' && t.date >= pdu && t.date <= pau).reduce((s, t) => s + t.net, 0);
  // temps de préparation (écran cuisine)
  const prep = {};
  for (const b of db.bons) { if (!b.pretTs || b.type !== 'commande') continue; const d = dateLocale(b.ts); if (d < du || d > au) continue; const k = (db.config.imprimantes[b.poste] || {}).nom || b.poste; (prep[k] = prep[k] || []).push((b.pretTs - b.ts) / 60000); }
  const tempsPrep = Object.fromEntries(Object.entries(prep).map(([k, v]) => [k, Math.round(v.reduce((a, x) => a + x, 0) / v.length)]));
  return {
    precedent, precedentDu: pdu, precedentAu: pau, tempsPrep,
    parSociete: Object.values(parSociete).sort((a, b) => b.montant - a.montant),
    du, au, nbTickets: tks.length, ca, especes, cheque, tpe, societe, offert, remises, couverts,
    ticketMoyen: tks.length ? Math.round(ca / tks.length) : 0,
    plats: Object.values(plats).sort((a, b) => b.qte - a.qte),
    categories: cats, jours, serveurs, heures,
    sorties: sorties.reduce((s, x) => s + x.montant, 0),
    rases: db.jours.filter(j => j.rase && j.date >= du && j.date <= au).map(j => ({ n: j.n, date: j.date, ...j.rase })),
  };
}
function rapportLignes(q) {
  const aujourdHui = dateLocale(now());
  const dateValide = d => /^\d{4}-\d{2}-\d{2}$/.test(d);
  const du = q.du || aujourdHui, au = q.au || aujourdHui;
  if (!dateValide(du) || !dateValide(au) || du > au) E('Période invalide');
  const vendeurs = new Map(db.users.map(u => [u.id, u.nom]));
  const lignes = [], totaux = new Map();
  const filtres = { article: q.article, famille: q.famille, vendeur: q.vendeur };
  const valeurs = { article: new Set(), famille: new Set(), vendeur: new Set() };
  const groupement = Object.hasOwn(filtres, q.grouper) ? q.grouper : 'article';
  for (const t of db.tickets.slice().reverse()) {
    if (t.date < du || t.date > au) continue;
    const eligible = l => !l.offert && !l.annule;
    const base = t.lignes.reduce((n, l) => n + (eligible(l) ? l.prix * l.qte : 0), 0);
    let cumul = 0, reparti = 0;
    for (const l of t.lignes) {
      if (eligible(l)) cumul += l.prix * l.qte;
      const part = base && !t.annule && t.mode !== 'offert' ? Math.round(t.net * cumul / base) : 0;
      const ligne = {
        ticket: t.num, date: t.date, table: t.table, saisiA: l.envoye || null, encaisseA: t.ts,
        article: l.nom, famille: l.catNom || 'Sans famille',
        vendeur: l.source === 'qr' ? 'QR code' : (l.saisiPar || vendeurs.get(l.par) || 'Non renseigné'),
        caissier: t.caissier, qte: l.qte, prix: l.prix, net: part - reparti,
        statut: t.annule || l.annule ? 'Annulé' : (l.offert || t.mode === 'offert') ? 'Offert' : 'Vendu',
      };
      reparti = part;
      for (const cle of Object.keys(valeurs)) valeurs[cle].add(ligne[cle]);
      if (Object.entries(filtres).some(([cle, v]) => v && v !== ligne[cle])) continue;
      lignes.push(ligne);
      const nom = ligne[groupement];
      const groupe = totaux.get(nom) || { nom, vendus: 0, offerts: 0, annules: 0, net: 0 };
      const quantite = { Vendu: 'vendus', Offert: 'offerts', Annulé: 'annules' }[ligne.statut];
      groupe[quantite] += ligne.qte;
      groupe.net += ligne.net;
      totaux.set(nom, groupe);
    }
  }
  const offset = Math.max(0, Number.parseInt(q.offset, 10) || 0);
  return {
    total: lignes.length, offset, lignes: lignes.slice(offset, offset + 100),
    filtres: Object.fromEntries(Object.entries(valeurs).map(([cle, v]) => [cle, [...v].sort((a, b) => a.localeCompare(b, 'fr'))])),
    groupes: [...totaux.values()].sort((a, b) => b.net - a.net),
  };
}
// ---- envoi de mails (Gmail, avec un mot de passe d'application), sans module externe
function envoyerMail(dest, sujet, texte) {
  const m = db.config.mail || {};
  return new Promise(resolve => {
    let fini = false, buf = '', etape = 0;
    const fin = r => { if (fini) return; fini = true; try { sock.end(); } catch (e) {} resolve(r); };
    const b64 = x => Buffer.from(x, 'utf8').toString('base64');
    const corps = b64(texte).replace(/.{76}/g, '$&\r\n');
    const msg = ['From: Caisse La Maison Blanche <' + m.user + '>', 'To: ' + dest, 'Subject: =?UTF-8?B?' + b64(sujet) + '?=', 'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', 'Date: ' + new Date().toUTCString(), '', corps, '.'].join('\r\n');
    const suite = [
      [220, () => 'EHLO caisse-maison-blanche'], [250, () => 'AUTH LOGIN'], [334, () => b64(m.user)], [334, () => b64(m.pass)],
      [235, () => 'MAIL FROM:<' + m.user + '>'], [250, () => 'RCPT TO:<' + dest + '>'], [250, () => 'DATA'], [354, () => msg], [250, () => 'QUIT'],
    ];
    const hote = process.env.CAISSE_SMTP_HOST || 'smtp.gmail.com';
    const sock = tls.connect(+process.env.CAISSE_SMTP_PORT || 465, hote, { servername: hote });
    sock.setTimeout(20000, () => fin({ ok: false, erreur: 'Pas de réponse du serveur mail (internet ?)' }));
    sock.on('error', e => fin({ ok: false, erreur: 'Mail : ' + (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN' ? 'pas d\'internet' : e.message) }));
    sock.on('data', d => {
      buf += d.toString('utf8');
      const lignes = buf.split('\r\n'); buf = lignes.pop();
      for (const l of lignes) {
        if (!/^\d{3} /.test(l)) continue; // réponse sur plusieurs lignes : on attend la dernière
        const code = +l.slice(0, 3);
        if (etape >= suite.length) return fin({ ok: true });
        const [attendu, cmd] = suite[etape];
        if (code !== attendu) return fin({ ok: false, erreur: code === 535 || code === 534 ? 'Gmail refuse le mot de passe : il faut un « mot de passe d\'application »' : 'Mail refusé (' + l.slice(0, 80) + ')' });
        etape++;
        if (etape === suite.length) { sock.write(cmd() + '\r\n'); return fin({ ok: true }); }
        sock.write(cmd() + '\r\n');
      }
    });
  });
}
// la rase au format de l'appli de gestion (collection « caisse »)
function raseAppli(j, r, rase) {
  return {
    id: 'J' + j.date, date: j.date, source: 'caisse', ca: r.ca, especes: r.especes, tpe: r.tpe, cheque: r.cheque, societe: r.societe, nbTickets: r.nbTickets, couverts: r.couverts,
    theorique: rase.attendu, compte: rase.compte, ecart: rase.ecart, caissier: rase.par,
    sorties: r.sorties.map(s => ({ montant: s.montant, note: [s.motif, s.detail].filter(Boolean).join(' - ') + (s.par ? ' (' + s.par + ')' : ''), type: /influen/i.test(s.motif) ? 'influenceuse' : 'depense', pj: null })),
    totalSorties: r.totalSorties, explication: rase.commentaire || '', parQui: rase.completePar || '', complete: !!(rase.ecart && rase.completePar),
    montantComplete: rase.ecart < 0 && rase.completePar ? -rase.ecart : 0, patron: r.patron, remises: r.remises, offert: r.offert, annulations: r.totalAnnulations,
    envoyeLe: new Date(rase.ts).toISOString(), photoX: 'caisse', statut: 'envoyee',
  };
}
function envoyerRase(j, r, rase) {
  const x = mailRase(j, r, rase);
  return envoyerMail(x.dest, x.sujet, x.texte);
}
function mailRase(j, r, rase) {
  const m = db.config.mail || {};
  const d = raseAppli(j, r, rase);
  const jour = new Date(j.date + 'T12:00').toLocaleDateString('fr-FR');
  const texte = 'Rase de la journée n° ' + j.n + ' du ' + jour + '\n\n' + raseDoc(r, rase).texte().replace(/\[(LOGO|QR[^\]]*)\]\n?/g, '') +
    '\n\n--- Données pour l\'appli de gestion (ne pas modifier) ---\nDONNEES-CAISSE ' + JSON.stringify(d) + '\n';
  const auto = rase.compte === null || rase.automatique;
  return { dest: m.dest || m.user, sujet: '[Caisse MB] Rase du ' + jour + ' - CA ' + fmt(r.ca) + ' DA - ' + (auto ? 'rase automatique, espèces à compter' : 'écart ' + fmt(rase.ecart) + ' DA'), texte };
}
function raseDoc(r, rase) {
  const d = new Doc();
  enteteTicket(d);
  d.center(1).size(2).bold(1).t(rase ? 'RAPPORT Z' : 'RAPPORT X').size(0).t('Journée n° ' + r.jour.n + ' du ' + new Date(r.jour.ouvert).toLocaleDateString('fr-FR')).bold(0).center(0);
  if (rase) d.t('Clôture ' + dateH(rase.ts) + ' par ' + rase.par); else d.center(1).t('Lecture en cours de journée - ' + dateH(now())).center(0);
  d.line();
  d.lr('Tickets', r.nbTickets); d.lr('Couverts', r.couverts);
  d.bold(1).lr('CHIFFRE D\'AFFAIRES', fmt(r.ca) + ' DA').bold(0);
  d.lr('  dont espèces', fmt(r.especes)); d.lr('  dont chèques', fmt(r.cheque)); d.lr('  dont carte (TPE)', fmt(r.tpe)); d.lr('  dont sur facture', fmt(r.societe));
  d.lr('Remises', fmt(r.remises)); d.lr('Offerts', fmt(r.offert)); d.lr('Table ' + db.config.tablePatron + ' (patron)', fmt(r.patron));
  d.lr('Annulations après envoi', fmt(r.totalAnnulations));
  d.line();
  d.bold(1).t('Par serveur').bold(0); for (const [k, v] of Object.entries(r.parServeur)) d.lr('  ' + k, fmt(v));
  d.bold(1).t('Par caissier').bold(0); for (const [k, v] of Object.entries(r.parCaissier)) d.lr('  ' + k, fmt(v));
  d.line();
  d.bold(1).t('Sorties de caisse').bold(0);
  for (const s of r.sorties) d.lr('  ' + s.motif + (s.detail ? ' - ' + s.detail : ''), fmt(s.montant));
  d.lr('Total sorties', fmt(r.totalSorties));
  d.line();
  d.lr('Fond de caisse', fmt(r.fondCaisse));
  if (rase) {
    d.lr('Espèces attendues (rase)', fmt(rase.attendu));
    d.lr('Espèces comptées', rase.compte === null ? 'Non comptées (auto)' : fmt(rase.compte));
    if (rase.ecart === null || rase.ecart === undefined) d.bold(1).lr('ÉCART', 'à vérifier').bold(0);
    else d.bold(1).lr('ÉCART', (rase.ecart > 0 ? '+' : '') + fmt(rase.ecart) + ' DA').bold(0);
    if (rase.completePar) d.t('Écart complété par : ' + rase.completePar);
    if (rase.commentaire) d.t('Note : ' + rase.commentaire);
  } else { d.bold(1).lr('Espèces dans le tiroir', fmt(r.attenduTiroir) + ' DA').bold(0); d.lr('Tables encore ouvertes', r.tablesOuvertes + ' - ' + fmt(r.montantOuvert) + ' DA'); }
  d.line();
  d.bold(1).t('Plats vendus').bold(0);
  const plats = {};
  for (const t of db.tickets) if (t.jour === r.jour.id && !t.annule) for (const l of t.lignes) if (!l.annule) plats[l.nom] = (plats[l.nom] || 0) + l.qte;
  for (const [k, v] of Object.entries(plats).sort((a, b) => b[1] - a[1])) d.lr('  ' + k, v);
  if (rase) d.feed(2).t('Signature caissier :').feed(3).t('Signature responsable :');
  d.cut();
  return d;
}

// ---------------------------------------------------------------- Événements en direct
const clients = new Set();
function broadcast() { for (const r of clients) { try { r.write('data: maj\n\n'); } catch (e) {} } }
setInterval(() => { for (const r of clients) { try { r.write(': ping\n\n'); } catch (e) {} } }, 25000);

// ---------------------------------------------------------------- API
class Err extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const E = (msg, code = 400) => { throw new Err(code, msg); };

// ------------------------------------------------------------ Réservations (téléphone + site)
const JOURS_FR = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MOIS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
function jourTxt(date) { const d = new Date(date + 'T12:00'); return JOURS_FR[d.getDay()] + ' ' + d.getDate() + ' ' + MOIS_FR[d.getMonth()]; }
function resaPublic(r) { return { id: r.id, date: r.date, heure: r.heure, nom: r.nom, tel: r.tel, couverts: r.couverts, salle: r.salle, table: r.table, note: r.note, statut: r.statut, source: r.source, par: r.par, ts: r.ts }; }
function resaTexte(r) {
  return [
    'Client : ' + r.nom + (r.tel ? ' - ' + r.tel : ''),
    'Quand : ' + jourTxt(r.date) + ' à ' + r.heure.replace(':', ' h '),
    'Personnes : ' + r.couverts,
    'Salle : ' + (r.salle ? salleNom(r.salle) : 'pas choisie') + (r.table ? ' - table ' + r.table : ''),
    r.note ? 'Remarque : ' + r.note : '',
    'Prise par : ' + (r.par || '-') + (r.source === 'site' ? ' (site internet)' : ' (téléphone)'),
  ].filter(Boolean).join('\n');
}
// mails de notification : gardés en attente tant qu'il n'y a pas d'internet
function notifier(sujet, texte) {
  const m = db.config.mail || {};
  if (!m.actif || !m.user || !m.pass) return;
  db.mailsAttente.push({ dest: m.dest || m.user, sujet, texte, ts: now() });
  save(); envoyerAttente();
}
let envoiEnCours = false;
async function envoyerAttente() {
  if (envoiEnCours) return;
  envoiEnCours = true;
  try {
    db.mailsAttente = db.mailsAttente.filter(x => x.important || now() - x.ts < 2 * 864e5);
    while (db.mailsAttente.length) {
      const x = db.mailsAttente[0];
      const r = await envoyerMail(x.dest, x.sujet, x.texte);
      if (!r.ok) break;
      db.mailsAttente.shift(); save();
    }
  } catch (e) {} finally { envoiEnCours = false; }
}

setInterval(envoyerAttente, 5 * 60000);
let raseAutoBusy = false, raseAutoReport = 0, raseAutoAverti = '';
async function verifierRaseAuto() {
  const cfg = db.config.raseAuto || {};
  if (raseAutoBusy || !cfg.actif || !/^([01]\d|2[0-3]):[0-5]\d$/.test(cfg.heure || '')) return;
  const j = jourCourant(false);
  if (!j || j.clos || j.rase) return;
  const d = new Date(), [h, m] = cfg.heure.split(':').map(Number);
  const debut = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
  if (j.ouvert > debut) return;
  const echeance = debut + raseAutoReport * 1800000;
  if (now() < echeance) {
    if (echeance - now() <= 300000 && raseAutoAverti !== String(echeance)) {
      raseAutoAverti = String(echeance);
      journal(null, 'avertissement rase automatique', 'Clôture prévue à ' + new Date(echeance).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }));
      save();
    }
    return;
  }
  const r = resumeJour(j);
  if (r.tablesOuvertes) {
    raseAutoReport++;
    journal(null, 'rase automatique reportée', r.tablesOuvertes + ' table(s) ouvertes ; report 30 minutes');
    save();
    return;
  }
  raseAutoBusy = true;
  try {
    const z = { ts: now(), par: 'Rase automatique', automatique: true, compte: null,
      attendu: r.aRemettre, ecart: null, completePar: '', commentaire: 'Comptage physique à effectuer',
      ca: r.ca, especes: r.especes, cheque: r.cheque, tpe: r.tpe,
      societe: r.societe, sorties: r.totalSorties, nbTickets: r.nbTickets };
    j.rase = z; j.clos = now();
    fermerTablesVides(null);
    journal(null, 'rase automatique', 'Journée ' + j.n + ' clôturée sans comptage physique');
    const mail = db.config.mail || {};
    if (mail.actif && mail.user && mail.pass) {
      // même format que la rase faite à la main (sujet « Rase du … », ligne DONNEES-CAISSE) pour l'appli de gestion
      const x = mailRase(j, r, z);
      db.mailsAttente.push({ ...x, ts: now(), important: true, raseAuto: j.id });
    }
    saveNow();
    const copie = path.join(BACKUPS, 'rase-auto-' + j.id + '.json');
    fs.copyFileSync(DB_FILE, copie);
    const fd = fs.openSync(copie, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const impression = await imprimer('ticket', raseDoc(r, z));
    if (!impression || !impression.ok) journal(null, 'impression rase auto', String(impression && impression.erreur || 'non confirmée'));
    // Retenter le SMTP pendant dix minutes maximum ; le message reste durablement en file.
    const finMail = now() + 10 * 60000;
    while (db.mailsAttente.some(x => x.raseAuto === j.id) && now() < finMail) {
      await Promise.race([envoyerAttente(), new Promise(resolve => setTimeout(resolve, 15000))]);
      if (db.mailsAttente.some(x => x.raseAuto === j.id))
        await new Promise(resolve => setTimeout(resolve, 15000));
    }
    if (!db.mailsAttente.some(x => x.raseAuto === j.id)) j.mailEnvoye = now(); else j.mailErreur = 'Pas encore envoyée (internet ?) : elle partira toute seule';
    db.extinctionNuit = dateLocale(now());
    journal(null, 'rase automatique', 'Sauvegarde validée, extinction ' + (cfg.extinction ? 'programmée' : 'désactivée'));
    saveNow();
    // Aucun arrêt de Windows après la rase automatique.
  } catch (e) {
    journal(null, 'erreur rase automatique', String(e.message || e));
    try { saveNow(); } catch (_) {}
  } finally { raseAutoBusy = false; raseAutoReport = 0; }
}
setInterval(() => { verifierRaseAuto().catch(e => console.error(e)); }, 15000);
// Extinction de nuit même quand la rase a déjà été faite à la main (version 3.5.6).
// Une seule fois par nuit, dans l'heure qui suit l'heure réglée, si aucune table n'est ouverte et si personne
// n'a utilisé la caisse depuis 5 minutes. La rase automatique ci-dessus s'occupe elle-même de l'extinction.
function extinctionDeNuit() {
  // Désactivée définitivement : la rase automatique reste indépendante de l'alimentation du PC.
}

setInterval(() => { try { extinctionDeNuit(); } catch (e) { console.error(e); } }, 30000);

function verifierResa(b) {
  const r = {
    date: String(b.date || ''), heure: String(b.heure || ''), nom: String(b.nom || '').trim().slice(0, 50), tel: String(b.tel || '').trim().slice(0, 30),
    couverts: parseInt(b.couverts, 10) || 0, salle: String(b.salle || ''), table: String(b.table || '').trim(), note: String(b.note || '').trim().slice(0, 200),
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) E('Choisissez la date');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(r.heure)) E('Choisissez une heure valide');
  const dateTest = new Date(r.date + 'T12:00:00');
  if (Number.isNaN(dateTest.getTime()) || dateLocale(dateTest.getTime()) !== r.date) E('Date de réservation invalide');
  if (!r.nom) E('Nom du client obligatoire');
  if (!(r.couverts >= 1 && r.couverts <= 200)) E('Nombre de personnes ?');
  if (r.salle && !db.config.salles.some(x => x.id === r.salle)) r.salle = '';
  if (!r.salle) r.table = '';
  return r;
}
const minutes = h => +h.slice(0, 2) * 60 + +h.slice(3, 5);
function conflitTable(r, id) {
  if (!r.table) return null;
  return db.reservations.find(x => x.id !== id && x.date === r.date && x.salle === r.salle && x.table === r.table && ['a_confirmer', 'prevue'].includes(x.statut) && Math.abs(minutes(x.heure) - minutes(r.heure)) < 120);
}
// ---- lecture des réservations du site (mails Web3Forms) dans Gmail, par IMAP
function imapLire(m, depuis) {
  return new Promise((resolve, reject) => {
    const hote = process.env.CAISSE_IMAP_HOST || 'imap.gmail.com';
    const sock = tls.connect(+process.env.CAISSE_IMAP_PORT || 993, hote, { servername: hote });
    let buf = Buffer.alloc(0), n = 0, attente = null, fini = false;
    const fin = (err, val) => { if (fini) return; fini = true; try { sock.end(); sock.destroy(); } catch (e) {} err ? reject(err) : resolve(val); };
    sock.setTimeout(30000, () => fin(new Error('pas de réponse de Gmail (internet ?)')));
    sock.on('error', e => fin(new Error(e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN' ? 'pas d\'internet' : e.message)));
    const cmd = c => new Promise(res => { n++; const tag = 'A' + n; attente = { tag, res }; sock.write(tag + ' ' + c + '\r\n'); });
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      if (!attente) { if (buf.indexOf('\r\n') >= 0) { const l = buf.toString('latin1'); buf = Buffer.alloc(0); if (!/^\* OK/.test(l)) fin(new Error('Gmail : ' + l.slice(0, 80))); else suite(); } return; }
      const t = buf.toString('latin1'), i = t.search(new RegExp('(^|\\r\\n)' + attente.tag + ' (OK|NO|BAD)'));
      if (i < 0) return;
      const j = t.indexOf('\r\n', i + 2);
      if (j < 0) return;
      const rep = buf.slice(0, j + 2); buf = buf.slice(j + 2);
      const a = attente; attente = null; a.res(rep);
    });
    const ok = (rep, quoi) => { const l = rep.toString('latin1').trim().split('\r\n').pop(); if (!/ OK/.test(l)) throw new Error(quoi + ' : ' + l.slice(0, 120)); };
    const dImap = d => d.getDate() + '-' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()] + '-' + d.getFullYear();
    let lance = false;
    const suite = async () => {
      if (lance) return; lance = true;
      try {
        const q = x => '"' + String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
        let r = await cmd('LOGIN ' + q(m.user) + ' ' + q(m.pass));
        const l = r.toString('latin1'); if (!/ OK/.test(l.trim().split('\r\n').pop())) throw new Error(/AUTHENTICATIONFAILED|Invalid credentials/i.test(l) ? 'Gmail refuse le mot de passe d\'application' : 'connexion Gmail refusée');
        ok(await cmd('SELECT INBOX'), 'boîte de réception');
        r = await cmd('UID SEARCH SINCE ' + dImap(depuis) + ' FROM "web3forms"'); ok(r, 'recherche');
        const uids = ((r.toString('latin1').match(/\* SEARCH([^\r\n]*)/) || [])[1] || '').trim().split(/\s+/).filter(Boolean).slice(-60);
        const mails = [];
        for (const uid of uids) {
          const f = await cmd('UID FETCH ' + uid + ' (BODY.PEEK[])');
          const mm = f.toString('latin1').match(/\{(\d+)\}\r\n/);
          if (!mm) continue;
          const debut = f.toString('latin1').indexOf(mm[0]) + mm[0].length;
          mails.push(f.slice(debut, debut + +mm[1]));
        }
        try { await cmd('LOGOUT'); } catch (e) {}
        fin(null, mails);
      } catch (e) { fin(e); }
    };
  });
}
// décodage minimal d'un mail (MIME) : en-têtes, sujet, texte lisible
function decodeMots(s) {
  return s.replace(/\?=\s+=\?/g, '?==?').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (x, cs, enc, t) => {
    const b = /b/i.test(enc) ? Buffer.from(t, 'base64') : Buffer.from(t.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (y, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
    return /utf-?8/i.test(cs) ? b.toString('utf8') : b.toString('latin1');
  });
}
function mimeParties(raw) {
  const t = raw.toString('latin1'), k = t.search(/\r?\n\r?\n/);
  const head = (k < 0 ? t : t.slice(0, k)).replace(/\r?\n[ \t]+/g, ' ');
  const body = k < 0 ? '' : t.slice(k).replace(/^\r?\n\r?\n/, '');
  const h = {}; for (const l of head.split(/\r?\n/)) { const i = l.indexOf(':'); if (i > 0) h[l.slice(0, i).toLowerCase().trim()] = l.slice(i + 1).trim(); }
  const ct = h['content-type'] || 'text/plain';
  const bd = (ct.match(/boundary="?([^";]+)"?/i) || [])[1];
  if (/^multipart\//i.test(ct) && bd) {
    const morceaux = body.split('--' + bd).slice(1).filter(x => !/^--/.test(x));
    return { h, parties: morceaux.flatMap(x => mimeParties(Buffer.from(x.replace(/^\r?\n/, ''), 'latin1')).parties) };
  }
  const te = (h['content-transfer-encoding'] || '').toLowerCase();
  let b = te === 'base64' ? Buffer.from(body.replace(/\s+/g, ''), 'base64') : te === 'quoted-printable' ? Buffer.from(body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (x, y) => String.fromCharCode(parseInt(y, 16))), 'latin1') : Buffer.from(body, 'latin1');
  const cs = (ct.match(/charset="?([^";]+)"?/i) || [])[1] || 'utf-8';
  return { h, parties: [{ type: ct.split(';')[0].toLowerCase(), texte: /utf-?8/i.test(cs) ? b.toString('utf8') : b.toString('latin1') }] };
}
function texteDeHtml(html) {
  return html.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p|tr|td|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (x, n) => String.fromCharCode(+n));
}
function resaDepuisMail(raw) {
  const { h, parties } = mimeParties(raw);
  const sujet = decodeMots(h.subject || '');
  if (!/^\s*R[ée]servation/i.test(sujet)) return null;
  const plain = parties.find(p => p.type === 'text/plain'), html = parties.find(p => p.type === 'text/html');
  const texte = plain && /Personnes|Nom/.test(plain.texte) ? plain.texte : html ? texteDeHtml(html.texte) : (plain ? plain.texte : '');
  const lignes = texte.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const champ = nom => {
    const re = new RegExp('^' + nom + '\\s*:\\s*(.*)$', 'i');
    for (let i = 0; i < lignes.length; i++) {
      const m = lignes[i].match(re); if (m && m[1]) return m[1].trim();
      if (new RegExp('^' + nom + '$', 'i').test(lignes[i]) && lignes[i + 1]) return lignes[i + 1];
    }
    return '';
  };
  const propre = v => (v === '-' ? '' : v);
  // date : « lundi 23 novembre » (année devinée), heure « 14 h 00 »
  const dt = (champ('Date') || sujet).toLowerCase().match(/(\d{1,2})\s+(janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre)(?:\s+(\d{4}))?/);
  const hr = (champ('Heure') || sujet).match(/(\d{1,2})\s*h\s*(\d{2})?/i);
  if (!dt || !hr) return null;
  const mi = ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre'].indexOf(dt[2].normalize('NFD').replace(/[̀-ͯ]/g, ''));
  let an = dt[3] ? +dt[3] : new Date().getFullYear();
  let date = an + '-' + String(mi + 1).padStart(2, '0') + '-' + String(+dt[1]).padStart(2, '0');
  if (!dt[3] && date < dateLocale(now() - 60 * 864e5)) date = (an + 1) + date.slice(4);
  const heure = String(+hr[1]).padStart(2, '0') + ':' + (hr[2] || '00');
  const esp = champ('Espace').toLowerCase();
  const salle = (db.config.salles.find(x => esp && (esp.includes(x.nom.toLowerCase()) || x.nom.toLowerCase().includes(esp.replace(/^salle\s+|^espace\s+/, '')))) || {}).id || '';
  const pers = parseInt(champ('Personnes') || (sujet.match(/(\d+)\s*pers/) || [])[1], 10) || 1;
  const nom = propre(champ('Nom')) || (sujet.split(',').pop() || '').trim() || 'Client du site';
  const notes = [propre(champ('Occasion')) && 'Occasion : ' + propre(champ('Occasion')), propre(champ('Remarque')), propre(champ('E-mail')) && 'Mail : ' + propre(champ('E-mail'))].filter(Boolean).join(' · ');
  return { id: (h['message-id'] || sujet + date + heure).replace(/[<>]/g, ''), date, heure, nom: nom.slice(0, 50), tel: propre(champ('T[ée]l[ée]phone') || champ('WhatsApp')).slice(0, 30), couverts: pers, salle, table: '', note: notes.slice(0, 200) };
}
let siteEtat = { dernier: 0, erreur: null, ajoutees: 0 };
let lectureSite = false;
async function lireSite() {
  const m = db.config.mail || {};
  if (!m.actif || !m.user || !m.pass || lectureSite) return siteEtat;
  lectureSite = true;
  try {
    const mails = await imapLire(m, new Date(now() - 4 * 864e5));
    let ajout = 0;
    for (const raw of mails) {
      let r; try { r = resaDepuisMail(raw); } catch (e) { r = null; }
      if (!r || db.siteVus.includes(r.id)) continue;
      db.siteVus.push(r.id); if (db.siteVus.length > 600) db.siteVus = db.siteVus.slice(-400);
      if (r.date < dateLocale(now())) continue;
      db.seq.resa++;
      db.reservations.push({ ...r, ext: r.id, id: 'R' + db.seq.resa, statut: 'a_confirmer', source: 'site', par: 'Site', ts: now() });
      ajout++;
    }
    siteEtat = { dernier: now(), erreur: null, ajoutees: siteEtat.ajoutees + ajout };
    if (ajout) save();
  } catch (e) { siteEtat = { ...siteEtat, dernier: now(), erreur: e.message }; }
  lectureSite = false;
  return siteEtat;
}
setTimeout(lireSite, 20000); setInterval(lireSite, 5 * 60000);
// une table réservée devient « arrivée » quand on l'ouvre autour de l'heure prévue
function arriveeAuto(c) {
  const h = new Date(), mn = h.getHours() * 60 + h.getMinutes(), auj = dateLocale(now());
  const r = db.reservations.find(x => x.date === auj && x.salle === c.salle && x.table === c.table && x.statut === 'prevue' && mn >= minutes(x.heure) - 30 && mn <= minutes(x.heure) + 90);
  if (r) { r.statut = 'arrivee'; r.arrivee = now(); }
}
function etatPublic(u) {
  const c = { ...db.config };
  // le mot de passe du mail ne quitte jamais la caisse principale
  if (c.mail) c.mail = { ...c.mail, pass: c.mail.pass ? '••••••••' : '' };
  if (c.qr) { const { secret, ...qrPublic } = c.qr; c.qr = qrPublic; }
  return {
    user: { id: u.id, nom: u.nom, role: u.role },
    config: c,
    raseAutoEtat: (() => {
      const j = jourCourant(false), cfg = db.config.raseAuto || {};
      if (!cfg.actif || !j || j.clos || j.rase) return null;
      const d = new Date(), [h, m] = String(cfg.heure || '02:00').split(':').map(Number);
      const base = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
      if (j.ouvert > base) return null;
      const ts = base + raseAutoReport * 1800000;
      return { ts, dansCinqMinutes: ts - now() <= 300000, report: raseAutoReport };
    })(),
    categories: db.categories.slice().sort((a, b) => a.ordre - b.ordre),
    produits: db.produits,
    users: db.users.map(x => ({ id: x.id, nom: x.nom, role: x.role, actif: x.actif })),
    commandes: Object.values(db.commandes).filter(x => x.statut === 'ouverte').map(x =>
      u.role !== 'serveur' || peutOuvrirCommande(x, u) ? x :
        { id: x.id, salle: x.salle, table: x.table, serveurId: x.serveurId, source: x.source, verrouillee: true, lignes: [] }),
    jour: jourCourant(false) || null,
    options: db.options, top: topVentes(), version: VERSION, qr: QR.etat(u),
    reservations: db.reservations.filter(r => r.date === dateLocale(now()) && ['a_confirmer', 'prevue'].includes(r.statut)).map(resaPublic),
    prets: db.bons.filter(b => b.etat === 'pret' && db.commandes[b.cmdId] && db.commandes[b.cmdId].statut === 'ouverte' && (u.role !== 'serveur' || peutOuvrirCommande(db.commandes[b.cmdId], u))).map(b => ({ id: b.id, cmdId: b.cmdId, poste: (db.config.imprimantes[b.poste] || {}).nom || b.poste, pretTs: b.pretTs, lignes: b.lignes.map(l => l.qte + ' ' + l.nom) })),
  };
}
let topCache = { ts: 0, ids: [] };
function topVentes() {
  if (now() - topCache.ts < 600000) return topCache.ids;
  const lim = dateLocale(now() - 30 * 864e5), n = {};
  for (const t of db.tickets) if (!t.annule && t.date >= lim) for (const l of t.lignes) if (!l.annule) n[l.pid] = (n[l.pid] || 0) + l.qte;
  topCache = { ts: now(), ids: Object.entries(n).sort((a, b) => b[1] - a[1]).map(x => x[0]).filter(id => db.produits.some(p => p.id === id && p.actif)).slice(0, 16) };
  return topCache.ids;
}
function bonsKds(poste) {
  const lim = now() - 20 * 60000;
  return db.bons.filter(b => (poste === 'tous' || b.poste === poste) && (b.etat === 'a_faire' || b.etat === 'attente' || (b.etat === 'pret' && b.pretTs > lim)))
    .map(b => { const c = db.commandes[b.cmdId] || {}; return { ...b, table: c.table || b.table, emporter: (c.salle || b.salle) === 'emporter', client: c.client || null, retrait: c.retrait || null, note: c.note || '', salle: salleNom(c.salle || b.salle), serveur: nomUser(b.serveurId), couverts: c.couverts || '' }; });
}
function peutOuvrirCommande(c, u) {
  return peut(u, 'caissier') || (u.role === 'serveur' && c.serveurId === u.id);
}
function verifierAccesCommande(c, u) {
  if (!peutOuvrirCommande(c, u)) E('Cette table est sous la responsabilité d’un autre serveur ou de la caisse.', 403);
}
function getCmd(id, u) {
  const c = db.commandes[id];
  if (!c) E('Commande introuvable', 404);
  verifierAccesCommande(c, u);
  if (c.statut !== 'ouverte') E('Cette table a déjà été encaissée ou fermée.');
  return c;
}


// Envoi d'articles sur une commande (3.6.0) : utilisé par « Envoyer » et par l'acceptation d'une commande QR.
// verifierLignes ne modifie rien (lève une erreur lisible si un article est invalide, épuisé ou incomplet).
function verifierLignes(c, lignes) {
  const besoin = {};
  if (!Array.isArray(lignes) || !lignes.length) E('Rien à envoyer');
  for (const x of lignes) {
    const q = Number(x.qte);
    if (!Number.isInteger(q) || q < 1 || q > 99) E('Quantité invalide (1 à 99)');
    besoin[x.pid] = (besoin[x.pid] || 0) + q;
  }
  for (const [pid, q] of Object.entries(besoin)) {
    const p = db.produits.find(p => p.id === pid);
    if (p && p.stock !== null && p.stock !== undefined && p.stock < q) E(p.stock <= 0 ? p.nom + ' est épuisé' : 'Il ne reste que ' + p.stock + ' « ' + p.nom + ' »');
  }
  const nouvelles = [];
  for (const x of lignes) {
    const p = db.produits.find(p => p.id === x.pid);
    if (!p) continue;
    const qte = Number(x.qte);
    if (p.id === 'supplement-fixe' && !String(x.note || '').trim()) E('Quel supplément ? Indiquez son nom avant de l’ajouter.');
    const cat = db.categories.find(k => k.id === p.cat) || {};
    // options (cuisson, accompagnement, suppléments…)
    const opts = [];
    for (const gid of p.options || []) {
      const g = db.options.find(o => o.id === gid); if (!g) continue;
      const indices = (x.opts || []).filter(o => o.g === gid).map(o => o.i);
      if (indices.some(i => !Number.isInteger(i) || i < 0 || i >= g.choix.length)) E('Option invalide pour ' + p.nom);
      if (new Set(indices).size !== indices.length) E('Option sélectionnée plusieurs fois');
      if (!g.multiple && indices.length > 1) E('Une seule option autorisée pour « ' + g.nom + ' »');
      const choisis = indices.map(i => g.choix[i]);
      if (g.obligatoire && !choisis.length) E('Choisissez « ' + g.nom + ' » pour ' + p.nom);
      for (const ch of g.multiple ? choisis : choisis.slice(0, 1)) opts.push({ g: gid, nom: ch.nom, prix: Math.round(+ch.prix || 0) });
    }
    const suite = x.suite !== undefined && x.suite !== null ? Math.max(0, Math.min(5, parseInt(x.suite, 10) || 0)) : (cat.suite || 0);
    nouvelles.push({ pid: p.id, nom: p.id === 'supplement-fixe' ? 'Supplément – ' + String(x.note).trim().slice(0, 90) : p.nom, prix: (p.id === 'supplement-fixe' ? 500 : p.prix) + opts.reduce((s, o) => s + o.prix, 0), opts, suite, catNom: cat.nom || '', qte, note: p.id === 'supplement-fixe' ? '' : String(x.note || '').slice(0, 120), emporter: !!x.emporter && c.salle !== 'emporter' });
  }
  if (!nouvelles.length) E('Rien à envoyer');
  return nouvelles;
}
async function envoyerLignes(c, lignes, u, opt = {}) {
  const prets = verifierLignes(c, lignes);
  const nouvelles = prets.map(l => { db.seq.ligne++; return { id: 'L' + db.seq.ligne, ...l, envoye: now(), par: opt.source === 'qr' ? null : u.id, saisiPar: opt.source === 'qr' ? null : u.nom, annule: null, offert: false, ...(opt.source ? { source: opt.source } : {}) }; });
  for (const l of nouvelles) { const p = db.produits.find(p => p.id === l.pid); if (p.stock !== null && p.stock !== undefined) p.stock -= l.qte; }
  const suiteAvant = c.lignes.some(l => l.envoye);
  c.lignes.push(...nouvelles);
  // la première suite commandée part tout de suite, les suivantes attendent la réclame
  const actives = c.lignes.filter(l => !l.annule && !l.paye && l.suite > 0).map(l => l.suite);
  if (actives.length) c.suite = Math.max(c.suite || 0, Math.min(...actives));
  if (opt.couverts) c.couverts = +opt.couverts;
  creerBons(c, nouvelles);
  const bonsAImprimer = [];
  // commande commune : l'asiatique voit aussi la partie cuisine (gastro/brunch) et inversement
  const CUISINES = ['cuisine', 'cuisine2', 'asiatique'];
  const dePoste = k => nouvelles.filter(l => postesDe(l.pid).includes(k));
  const commune = dePoste('asiatique').length && (dePoste('cuisine').length || dePoste('cuisine2').length);
  const titre = [opt.entete, suiteAvant ? '-- SUITE DE COMMANDE --' : ''].filter(Boolean).join('\n');
  for (const poste of postesBons()) {
    const ls = dePoste(poste);
    if (!ls.length) continue;
    let infos = null;
    if (commune && CUISINES.includes(poste)) {
      infos = {};
      for (const k of CUISINES) if (k !== poste && !(poste !== 'asiatique' && k !== 'asiatique')) { const autres = dePoste(k).filter(l => !ls.includes(l)); if (autres.length) infos[k] = autres; }
    }
    bonsAImprimer.push({ poste, doc: bon(poste, c, ls, titre, infos) });
  }
  if (opt.avantImpression) opt.avantImpression(nouvelles, bonsAImprimer);
  save();
  if (opt.durable) saveNow();
  const erreurs = [], echecs = [];
  for (const { poste, doc } of bonsAImprimer) {
    const r = await imprimer(poste, doc);
    if (r.ok) opt.apresImpression?.(poste);
    else { erreurs.push(r.erreur); echecs.push(poste); }
  }
  journal(u, 'envoi', (opt.source === 'qr' ? '[QR] ' : '') + 'Table ' + c.table + ' : ' + nouvelles.map(l => l.qte + ' ' + l.nom).join(', '));
  return { nouvelles, erreurs, echecs };
}
const autorisationsPointage = new Map();
const routes = {
  'POST /api/login': (b, _u, req) => {
    const ip = controleEssais(req);
    const u = parCode(b.badge || b.pin);
    if (!u) { echecAcces(ip); E(b.badge ? 'Badge inconnu' : 'Code incorrect', 401); }
    succesAcces(ip);
    const token = crypto.randomBytes(18).toString('hex');
    sessions.set(token, { userId: u.id, ts: now(), created: now() });
    sauverSessions();
    journal(u, 'connexion', '');
    return { token, user: { id: u.id, nom: u.nom, role: u.role } };
  },
  'GET /api/etat': (b, u) => etatPublic(u),
  'GET /api/reservations': (b, u, req, q) => {
    if (u.role === 'cuisine') E('Non autorisé', 403);
    const du = /^\d{4}-\d{2}-\d{2}$/.test(q.du || '') ? q.du : dateLocale(now()), au = /^\d{4}-\d{2}-\d{2}$/.test(q.au || '') ? q.au : du;
    return { reservations: db.reservations.filter(r => r.date >= du && r.date <= au).sort((a, b) => (a.date + a.heure).localeCompare(b.date + b.heure)).map(resaPublic), site: siteEtat, mail: !!(db.config.mail && db.config.mail.actif && db.config.mail.pass) };
  },
  'POST /api/reservation': (b, u) => {
    if (!peut(u, 'caissier')) E('Seuls les caissiers peuvent prendre une réservation', 403);
    const r = verifierResa(b);
    const ex = b.id ? db.reservations.find(x => x.id === b.id) : null;
    if (b.id && !ex) E('Réservation introuvable');
    const c = conflitTable(r, ex && ex.id);
    if (c && !b.forcer) E('La table ' + r.table + ' est déjà réservée à ' + c.heure + ' (' + c.nom + ')', 409);
    if (ex) {
      Object.assign(ex, r, { modifiePar: u.nom, modifie: now() });
      const confirme = ex.statut === 'a_confirmer' && b.confirmer;
      if (confirme) ex.statut = 'prevue';
      journal(u, confirme ? 'réservation du site confirmée' : 'réservation modifiée', ex.nom + ' ' + ex.date + ' ' + ex.heure);
      save(); notifier('[Caisse MB] ' + (confirme ? 'Réservation du site confirmée' : 'Réservation modifiée') + ' : ' + ex.nom + ', ' + ex.couverts + ' pers., ' + jourTxt(ex.date) + ' à ' + ex.heure, resaTexte(ex) + '\n' + (confirme ? 'Confirmée' : 'Modifiée') + ' par : ' + u.nom);
      return resaPublic(ex);
    }
    db.seq.resa++;
    const n = { id: 'R' + db.seq.resa, ...r, statut: 'prevue', source: 'telephone', par: u.nom, ts: now() };
    db.reservations.push(n);
    journal(u, 'réservation', n.nom + ' ' + n.date + ' ' + n.heure + ' ' + n.couverts + ' pers.');
    save(); notifier('[Caisse MB] Nouvelle réservation : ' + n.nom + ', ' + n.couverts + ' pers., ' + jourTxt(n.date) + ' à ' + n.heure, resaTexte(n));
    return resaPublic(n);
  },
  'POST /api/reservation/statut': (b, u) => {
    const r = db.reservations.find(x => x.id === b.id);
    if (!r) E('Réservation introuvable');
    if (!['prevue', 'arrivee', 'annulee', 'absent'].includes(b.statut)) E('Statut inconnu');
    if (!peut(u, 'caissier') && b.statut !== 'arrivee') E('Seuls les caissiers peuvent faire ça', 403);
    const avant = r.statut;
    r.statut = b.statut; if (b.statut === 'arrivee') r.arrivee = now();
    journal(u, 'réservation ' + b.statut, r.nom + ' ' + r.date + ' ' + r.heure);
    save();
    if (b.statut === 'annulee' && avant !== 'annulee') notifier('[Caisse MB] Réservation annulée : ' + r.nom + ', ' + jourTxt(r.date) + ' à ' + r.heure, resaTexte(r) + '\nAnnulée par : ' + u.nom);
    if (b.statut === 'prevue' && avant === 'a_confirmer') notifier('[Caisse MB] Réservation du site confirmée : ' + r.nom + ', ' + r.couverts + ' pers., ' + jourTxt(r.date) + ' à ' + r.heure, resaTexte(r) + '\nConfirmée par : ' + u.nom);
    return resaPublic(r);
  },
  'POST /api/reservations/site': async (b, u) => { if (!peut(u, 'caissier')) E('Non autorisé', 403); return await lireSite(); },
  'POST /api/logout': (b, u, req) => { sessions.delete(req.headers['x-token']); return {}; },

  'POST /api/commande/ouvrir': (b, u, _req, _query, estQr = false) => {
    if (u.role === 'cuisine') E('Non autorisé', 403);
    const salle = b.salle;
    let table = String(b.table || '');
    // numéro du jour pour les commandes à emporter : E1, E2…
    if (salle === 'emporter') { const jj = jourCourant(true); table = 'E' + (Object.values(db.commandes).filter(x => x.salle === 'emporter' && x.jour === jj.id).length + 1); }
    if (!table) E('Table manquante');
    const ex = Object.values(db.commandes).find(c => c.statut === 'ouverte' && c.salle === salle && c.table === table && salle !== 'comptoir');
    if (ex) { verifierAccesCommande(ex, u); return ex; }
    // table réservée (bloquée 30 min avant) : seul un caissier peut l'ouvrir
    if (salle !== 'emporter' && salle !== 'comptoir' && !peut(u, 'caissier')) {
      const h = new Date(), mn = h.getHours() * 60 + h.getMinutes(), auj = dateLocale(now());
      const rs = db.reservations.find(x => x.date === auj && x.salle === salle && x.table === table && x.statut === 'prevue' && mn >= minutes(x.heure) - 30 && mn <= minutes(x.heure) + 60);
      if (rs) {
        const chef = parCode(b.pin);
        if (!chef || !peut(chef, 'caissier')) E('Table réservée à ' + rs.heure + ' pour ' + rs.nom + ' : seul un caissier peut l\'ouvrir', 403);
        journal(u, 'table réservée ouverte', salleNom(salle) + ' ' + table + ' (' + rs.nom + ') autorisé par ' + chef.nom);
      }
    }
    const j = jourCourant(true);
    db.seq.cmd++;
    const c = { id: 'C' + db.seq.cmd, salle, table, couverts: +b.couverts || 1, serveurId: estQr ? null : u.id, ...(estQr ? { source: 'qr' } : {}), ouverte: now(), lignes: [], statut: 'ouverte', jour: j.id, additionTs: null, note: '' };
    if (salle === 'emporter') { c.client = { nom: String(b.client && b.client.nom || '').slice(0, 40), tel: String(b.client && b.client.tel || '').slice(0, 20) }; c.retrait = +b.retrait || null; }
    db.commandes[c.id] = c;
    if (salle !== 'emporter' && salle !== 'comptoir') arriveeAuto(c);
    journal(u, 'ouverture table', salleNom(salle) + ' ' + table);
    save();
    return c;
  },
  'POST /api/commande/envoyer': async (b, u) => {
    if (u.role === 'cuisine') E('Non autorisé', 403);
    const c = getCmd(b.id, u);
    const r = await envoyerLignes(c, b.lignes, u, { couverts: b.couverts });
    return { commande: c, erreurs: r.erreurs };
  },
  'POST /api/commande/reclamer': async (b, u) => {
    const c = getCmd(b.id, u);
    const att = c.lignes.filter(l => !l.annule && !l.paye && l.suite > (c.suite || 0));
    if (!att.length) E('Rien en attente pour cette table');
    const s = Math.min(...att.map(l => l.suite));
    c.suite = s;
    const ls = att.filter(l => l.suite === s);
    for (const bn of db.bons) if (bn.cmdId === c.id && bn.etat === 'attente' && bn.suite === s) { bn.etat = 'a_faire'; bn.ts = now(); bn.reclame = true; }
    save();
    const erreurs = [];
    for (const poste of postesBons()) {
      const lp = ls.filter(l => postesDe(l.pid).includes(poste));
      if (!lp.length) continue;
      const d = new Doc();
      d.center(1).size(2).bold(1).t('RÉCLAME').t(SUITES[s].toUpperCase()).size(0).bold(0).center(0).line('=');
      d.size(2).bold(1).t(titreCmd(c)).size(0).bold(0).t(salleNom(c.salle) + '   ' + heure(now()) + '   ' + nomUser(c.serveurId)).line();
      for (const l of lp) lignesBon(d, l);
      d.line().cut();
      const r = await imprimer(poste, d);
      if (!r.ok) erreurs.push(r.erreur);
    }
    journal(u, 'réclame', 'Table ' + c.table + ' : ' + SUITES[s]);
    return { commande: c, suite: SUITES[s], erreurs };
  },
  'POST /api/commande/message': async (b, u) => {
    const c = getCmd(b.id, u);
    const texte = String(b.texte || '').trim().slice(0, 140);
    if (!texte) E('Message vide');
    const postes = b.poste === 'tous' ? postesBons() : [b.poste].filter(p => postesBons().includes(p));
    if (!postes.length) E('Choisissez où envoyer le message');
    const erreurs = [];
    for (const poste of postes) {
      db.seq.bon++;
      db.bons.push({ id: 'B' + db.seq.bon, cmdId: c.id, salle: c.salle, table: c.table, serveurId: u.id, poste, ts: now(), suite: 0, type: 'message', etat: 'a_faire', lignes: [{ qte: '', nom: texte, opts: [], note: '' }] });
      const d = new Doc();
      d.center(1).size(2).bold(1).t('MESSAGE').size(0).bold(0).center(0).line('=');
      d.size(2).bold(1).t(titreCmd(c)).size(0).bold(0).t(nomUser(u.id) + '   ' + heure(now())).line();
      d.size(3).bold(1).t(texte).size(0).bold(0).line().cut();
      const r = await imprimer(poste, d); if (!r.ok) erreurs.push(r.erreur);
    }
    save();
    journal(u, 'message', 'Table ' + c.table + ' : ' + texte);
    return { erreurs };
  },
  'POST /api/commande/servi': (b, u) => {
    for (const bn of db.bons) if (bn.cmdId === b.id && bn.etat === 'pret' && (!b.bon || bn.id === b.bon)) { bn.etat = 'servi'; bn.serviTs = now(); }
    save(); return {};
  },
  // ---- écran cuisine
  'GET /api/kds': (b, u, req, q) => {
    if (u.role === 'serveur') E('Non autorisé', 403);
    return { bons: bonsKds(q.poste || 'tous'), produits: db.produits.filter(p => p.actif).map(p => ({ id: p.id, nom: p.nom, stock: p.stock, poste: posteDe(p.id) })) };
  },
  'POST /api/kds/pret': (b, u) => {
    if (u.role === 'serveur') E('Non autorisé', 403);
    const bn = db.bons.find(x => x.id === b.id); if (!bn) E('Bon introuvable');
    if (bn.type === 'commande') { bn.etat = 'pret'; bn.pretTs = now(); bn.pretPar = u.nom; } else { bn.etat = 'servi'; bn.pretTs = now(); }
    save(); return {};
  },
  'POST /api/kds/rappel': (b, u) => {
    if (u.role === 'serveur') E('Non autorisé', 403);
    const bn = db.bons.find(x => x.id === b.id); if (!bn) E('Bon introuvable');
    bn.etat = 'a_faire'; bn.pretTs = null; save(); return {};
  },
  'POST /api/produit/stock': (b, u) => {
    if (u.role === 'serveur') E('Seuls la cuisine, la caisse et le responsable gèrent les ruptures', 403);
    const p = db.produits.find(x => x.id === b.pid); if (!p) E('Article introuvable');
    p.stock = b.stock === null || b.stock === '' || b.stock === undefined ? null : Math.max(0, parseInt(b.stock, 10) || 0);
    journal(u, 'rupture / stock', p.nom + ' : ' + (p.stock === null ? 'disponible' : p.stock === 0 ? 'ÉPUISÉ' : 'reste ' + p.stock));
    save(); return { pid: p.id, stock: p.stock };
  },
  'POST /api/commande/reimprimer-bons': async (b, u) => {
    const c = getCmd(b.id, u);
    const erreurs = [];
    for (const poste of postesBons()) {
      const ls = c.lignes.filter(l => !l.annule && postesDe(l.pid).includes(poste));
      if (!ls.length) continue;
      const r = await imprimer(poste, bon(poste, c, ls, '** RÉIMPRESSION **'));
      if (!r.ok) erreurs.push(r.erreur);
    }
    return { erreurs };
  },
  'POST /api/commande/annuler-ligne': async (b, u) => {
    const c = getCmd(b.id, u);
    const l = c.lignes.find(x => x.id === b.ligne);
    if (!l || l.annule) E('Ligne introuvable');
    if (l.paye) E('Cet article est déjà payé');
    // seuls les caissiers (et le responsable) peuvent annuler un plat déjà envoyé
    const chef = peut(u, 'caissier') ? u : parCode(b.pin);
    if (!chef || !peut(chef, 'caissier')) E('Seul un caissier peut annuler un plat : passez le badge ou tapez le code d\'un caissier', 403);
    if (!b.motif) E('Motif obligatoire');
    const q = Math.max(1, Math.min(l.qte, parseInt(b.qte, 10) || l.qte));
    let cible = l;
    if (q < l.qte) { l.qte -= q; db.seq.ligne++; cible = { ...l, id: 'L' + db.seq.ligne, qte: q }; c.lignes.push(cible); }
    cible.annule = { par: chef.nom, demandePar: u.nom, motif: b.motif, ts: now() };
    const pr = db.produits.find(p => p.id === l.pid); if (pr && pr.stock !== null && pr.stock !== undefined) pr.stock += q;
    for (const k of postesDe(l.pid)) { db.seq.bon++; db.bons.push({ id: 'B' + db.seq.bon, cmdId: c.id, salle: c.salle, table: c.table, serveurId: c.serveurId, poste: k, ts: now(), suite: 0, type: 'annulation', etat: 'a_faire', lignes: [{ qte: q, nom: l.nom, opts: [], note: b.motif }] }); }
    journal(u, 'annulation article', 'Table ' + c.table + ' : ' + q + ' ' + l.nom + ' (' + b.motif + ') autorisé par ' + chef.nom);
    save();
    const d = new Doc();
    d.center(1).size(2).bold(1).t('*** ANNULATION ***').size(0).bold(0).center(0).t('Table ' + c.table + ' - ' + heure(now())).line();
    d.size(3).bold(1).t(q + '  ' + l.nom).size(0).bold(0).t('Motif : ' + b.motif).cut();
    const erreurs = [];
    for (const k of postesDe(l.pid)) { const r = await imprimer(k, d); if (!r.ok) erreurs.push(r.erreur); }
    return { commande: c, erreurs };
  },
  'POST /api/commande/offrir-ligne': (b, u) => {
    const c = getCmd(b.id, u);
    const l = c.lignes.find(x => x.id === b.ligne);
    if (!l || l.annule) E('Ligne introuvable');
    if (l.paye) E('Cet article est déjà payé');
    const chef = pinAdmin(b.pin);
    if (!chef) E('Code du responsable obligatoire', 403);
    l.offert = !l.offert;
    journal(u, l.offert ? 'article offert' : 'article plus offert', 'Table ' + c.table + ' : ' + l.qte + ' ' + l.nom + ' par ' + chef.nom);
    save();
    return c;
  },
  'POST /api/commande/modifier': (b, u) => {
    const c = getCmd(b.id, u);
    let destinataire;
    if (b.serveurId !== undefined) {
      if (u.role !== 'caissier') E('Seul le caissier peut attribuer une table', 403);
      destinataire = db.users.find(x => x.actif && x.role === 'serveur' && x.id === b.serveurId);
      if (!destinataire) E('Serveur actif introuvable');
    }
    const deplace = b.salle && b.table;
    const t = deplace ? String(b.table) : null;
    const occ = deplace && Object.values(db.commandes).find(x => x.statut === 'ouverte' && x.id !== c.id && x.salle === b.salle && x.table === t);
    if (occ) verifierAccesCommande(occ, u);
    if (b.couverts) c.couverts = Math.max(1, +b.couverts);
    if (occ) {
      occ.lignes.push(...c.lignes); occ.couverts += c.couverts; c.statut = 'fusionnee'; c.lignes = [];
      journal(u, 'fusion tables', c.table + ' -> ' + t);
    } else if (deplace) {
      journal(u, 'déplacement table', salleNom(c.salle) + ' ' + c.table + ' -> ' + salleNom(b.salle) + ' ' + t);
      c.salle = b.salle; c.table = t;
    }
    const cible = occ || c;
    if (destinataire) {
      cible.serveurId = destinataire.id;
      journal(u, 'attribution table', salleNom(cible.salle) + ' ' + cible.table + ' → ' + destinataire.nom);
    }
    if (b.note !== undefined) cible.note = String(b.note).slice(0, 160);
    if (b.client) cible.client = { nom: String(b.client.nom || '').slice(0, 40), tel: String(b.client.tel || '').slice(0, 20) };
    if (b.retrait !== undefined) cible.retrait = +b.retrait || null;
    save();
    return cible;
  },
  'POST /api/commande/fermer-vide': (b, u) => {
    const c = getCmd(b.id, u);
    if (c.lignes.some(l => !l.annule && !l.paye)) E('La table a encore des articles : il faut les annuler ou encaisser.');
    c.statut = 'annulee'; c.ferme = now();
    journal(u, 'fermeture table vide', 'Table ' + c.table);
    save(); return {};
  },
  'POST /api/commande/addition': async (b, u) => {
    const c = getCmd(b.id, u);
    if (!c.lignes.some(l => !l.annule && !l.paye)) E('La table est vide');
    c.additionTs = now(); save();
    const r = await imprimer('ticket', additionDoc(c));
    journal(u, 'addition', 'Table ' + c.table + ' ' + fmt(totalCmd(c)) + ' DA');
    return { erreurs: r.ok ? [] : [r.erreur] };
  },
  'POST /api/commande/encaisser': async (b, u) => {
    if (!peut(u, 'caissier')) E('Seule la caisse peut encaisser', 403);
    const c = getCmd(b.id, u);
    const restantes = () => c.lignes.filter(l => !l.annule && !l.paye);
    if (!restantes().length) E('La table est vide');
    // Préparer la séparation sans modifier la commande avant validation du paiement.
    let selections = [];
    if (Array.isArray(b.lignes) && b.lignes.length) {
      const deja = new Set();
      for (const x of b.lignes) {
        const l = c.lignes.find(k => k.id === x.id && !k.annule && !k.paye);
        if (!l) E('Article introuvable ou déjà payé');
        if (deja.has(l.id)) E('Article sélectionné plusieurs fois');
        deja.add(l.id);
        const q = x.qte == null ? l.qte : Number(x.qte);
        if (!Number.isInteger(q) || q < 1 || q > l.qte) E('Quantité à encaisser invalide');
        selections.push({ ligne: l, qte: q });
      }
    } else selections = restantes().map(l => ({ ligne: l, qte: l.qte }));
    const total = selections.reduce((s, x) => s + (x.ligne.offert ? 0 : x.qte * x.ligne.prix), 0);
    let remise = 0;
    if (b.remise && +b.remise.valeur > 0) {
      if (!pinAdmin(b.pin)) E('Code du responsable obligatoire pour une remise', 403);
      remise = b.remise.type === 'pct' ? Math.round(total * Math.min(100, +b.remise.valeur) / 100) : Math.min(total, Math.round(+b.remise.valeur));
    }
    // paiements : un seul mode, ou plusieurs (ex. une partie en espèces, le reste par carte)
    let pays = Array.isArray(b.paiements) && b.paiements.length ? b.paiements : [{ mode: b.mode, montant: b.mode === 'especes' ? (+b.recu || 0) : null, societe: b.societe, reference: b.reference }];
    pays = pays.map(p => ({ mode: p.mode, montant: Math.round(+p.montant || 0), societe: String(p.societe || '').trim(), reference: String(p.reference || '').trim().slice(0, 40) }));
    if (pays.some(p => !Number.isSafeInteger(p.montant) || p.montant < 0)) E('Montant de paiement invalide');
    for (const p of pays) if (!MODES[p.mode]) E('Mode de paiement inconnu');
    const offert = pays.some(p => p.mode === 'offert');
    if (offert && pays.length > 1) E('Une table offerte ne peut pas être payée en plus');
    if (offert && !pinAdmin(b.pin)) E('Code du responsable obligatoire pour offrir la table', 403);
    for (const p of pays) if (p.mode === 'societe' && !p.societe) E('Nom de la société obligatoire');
    const net = offert ? 0 : total - remise;
    if (pays.length === 1 && !offert && !(pays[0].montant > 0)) pays[0].montant = net;
    const somme = offert ? 0 : pays.reduce((s, p) => s + p.montant, 0);
    if (somme < net) E('Il manque ' + fmt(net - somme) + ' DA');
    const recu = pays.filter(p => p.mode === 'especes').reduce((s, p) => s + p.montant, 0);
    const rendu = somme - net;
    if (rendu > recu) E('Seules les espèces peuvent dépasser le montant à payer');
    // on garde ce qui est réellement encaissé (espèces = reçu - rendu)
    let aDeduire = rendu;
    const paiements = [];
    for (const p of pays.slice().reverse()) { let m = p.montant; if (p.mode === 'especes' && aDeduire > 0) { const k = Math.min(m, aDeduire); m -= k; aDeduire -= k; } if (m > 0 || offert) paiements.unshift({ ...p, montant: offert ? 0 : m }); }
    const modes = [...new Set(paiements.map(p => p.mode))];
    const mode = modes.length === 1 ? modes[0] : 'mixte';
    // Toutes les validations sont passées : appliquer les séparations seulement maintenant.
    const lignes = [];
    for (const { ligne, qte } of selections) {
      if (qte < ligne.qte) {
        ligne.qte -= qte;
        db.seq.ligne++;
        const part = { ...ligne, id: 'L' + db.seq.ligne, qte };
        c.lignes.push(part);
        lignes.push(part);
      } else lignes.push(ligne);
    }
    const j = db.jours.find(x => x.id === c.jour && !x.clos) || jourCourant(true);
    db.seq.ticket++;
    for (const l of lignes) l.paye = db.seq.ticket;
    const partiel = restantes().length > 0;
    const tk = {
      client: c.client || null,
      num: db.seq.ticket, cmdId: c.id, jour: j.id, date: j.date, ts: now(), salle: c.salle, table: c.table, couverts: partiel ? 0 : c.couverts,
      serveur: nomUser(c.serveurId), serveurId: c.serveurId, caissier: u.nom, lignes: lignes.map(l => ({ ...l })), total, remise: offert ? 0 : remise, net,
      mode, paiements, societe: paiements.filter(p => p.mode === 'societe').map(p => p.societe).join(', '), reference: paiements.map(p => p.reference).filter(Boolean).join(', '),
      motif: b.motif || '', recu, rendu: recu ? rendu : 0,
      patron: c.table === String(db.config.tablePatron), partiel,
    };
    db.tickets.push(tk);
    if (topCache.ids.length < 16) topCache.ts = 0;
    if (!partiel) { c.statut = 'payee'; c.ticket = tk.num; c.ferme = now(); }
    for (const p of paiements) if (p.mode === 'societe' && !db.config.societes.includes(p.societe)) db.config.societes.push(p.societe);
    // Le ticket est conservé sur disque avant toute impression ou réponse au navigateur.
    saveNow();
    journal(u, 'encaissement', 'Ticket ' + tk.num + ' table ' + c.table + ' ' + fmt(net) + ' DA (' + paiements.map(p => MODES[p.mode] + ' ' + fmt(p.montant)).join(' + ') + ')' + (remise ? ' remise ' + fmt(remise) : '') + (partiel ? ' — paiement partiel' : ''));
    save();
    const d = ticketDoc(tk);
    const tiroir = recu > 0 && db.config.tiroirAuto;
    if (tiroir) d.drawer();
    const r = b.imprimer === false && !tiroir ? { ok: true } : await imprimer('ticket', b.imprimer === false ? new Doc().drawer() : d);
    return { ticket: tk, partiel, erreurs: r.ok ? [] : [r.erreur] };
  },
  'POST /api/tiroir': async (b, u) => {
    if (!peut(u, 'caissier')) E('Non autorisé', 403);
    journal(u, 'ouverture tiroir', b.motif || '');
    const r = await imprimer('ticket', new Doc().drawer());
    return { erreurs: r.ok ? [] : [r.erreur] };
  },
  'GET /api/caisse': (b, u, req, q) => {
    if (!peut(u, 'caissier')) E('Non autorisé', 403);
    const j = jourCourant(false);
    return {
      resume: resumeJour(j),
      tickets: j ? db.tickets.filter(t => t.jour === j.id).slice().reverse() : [],
      derniereRase: db.jours.filter(x => x.rase).slice(-1)[0] || null,
    };
  },
  'POST /api/ticket/reimprimer': async (b, u) => {
    if (!peut(u, 'caissier')) E('Non autorisé', 403);
    const tk = db.tickets.find(t => t.num === +b.num);
    if (!tk) E('Ticket introuvable');
    journal(u, 'duplicata', 'Ticket ' + tk.num);
    const r = await imprimer('ticket', ticketDoc(tk, true));
    return { erreurs: r.ok ? [] : [r.erreur] };
  },
  'POST /api/ticket/annuler': (b, u) => {
    if (!peut(u, 'caissier')) E('Non autorisé', 403);
    const chef = pinAdmin(b.pin);
    if (!chef) E('Code du responsable obligatoire', 403);
    const tk = db.tickets.find(t => t.num === +b.num);
    if (!tk || tk.annule) E('Ticket introuvable');
    const j = db.jours.find(x => x.id === tk.jour);
    if (j && j.clos) E('La journée de ce ticket est déjà clôturée');
    if (!b.motif) E('Motif obligatoire');
    tk.annule = { par: chef.nom, motif: b.motif, ts: now() };
    if (b.rouvrir) {
      const c = db.commandes[tk.cmdId];
      if (c) {
        if (c.statut !== 'ouverte' && Object.values(db.commandes).some(x => x.statut === 'ouverte' && x.salle === c.salle && x.table === c.table && x.id !== c.id)) E('La table ' + c.table + ' est de nouveau occupée : impossible de la rouvrir. Annulez sans rouvrir.');
        for (const l of c.lignes) if (l.paye === tk.num) l.paye = null;
        c.statut = 'ouverte'; delete c.ticket;
      }
    }
    journal(u, 'annulation ticket', 'Ticket ' + tk.num + ' ' + fmt(tk.net) + ' DA (' + b.motif + ') par ' + chef.nom + (b.rouvrir ? ', table rouverte' : ''));
    save(); return {};
  },
  'POST /api/sortie': (b, u) => {
    if (!peut(u, 'caissier')) E('Non autorisé', 403);
    const montant = Math.round(+b.montant);
    if (!(montant > 0)) E('Montant invalide');
    if (!b.motif) E('Motif obligatoire');
    const j = jourCourant(true);
    db.seq.sortie++;
    const s = { id: 'S' + db.seq.sortie, jour: j.id, date: j.date, ts: now(), montant, motif: b.motif, detail: String(b.detail || '').slice(0, 120), par: u.nom };
    db.sorties.push(s);
    journal(u, 'sortie de caisse', fmt(montant) + ' DA ' + s.motif + ' ' + s.detail);
    save();
    return s;
  },
  'POST /api/sortie/supprimer': (b, u) => {
    if (!pinAdmin(b.pin)) E('Code du responsable obligatoire', 403);
    const i = db.sorties.findIndex(s => s.id === b.id);
    if (i < 0) E('Sortie introuvable');
    const s = db.sorties[i]; const j = db.jours.find(x => x.id === s.jour);
    if (j && j.clos) E('Journée déjà clôturée');
    db.sorties.splice(i, 1); journal(u, 'suppression sortie', fmt(s.montant) + ' ' + s.motif); save(); return {};
  },
  'POST /api/rase-auto/reporter': (b, u) => {
    if (!peut(u, 'admin')) E('Seul le responsable peut reporter la rase', 403);
    if (!db.config.raseAuto || !db.config.raseAuto.actif) E('Rase automatique désactivée');
    const j = jourCourant(false);
    if (!j || j.clos || j.rase || raseAutoBusy) E('Aucune rase à reporter');
    raseAutoReport++;
    journal(u, 'rase automatique reportée', 'Report manuel de 30 minutes');
    save();
    return { report: raseAutoReport };
  },
  'POST /api/rase': async (b, u) => {
    if (!peut(u, 'caissier')) E('Non autorisé', 403);
    const j = jourCourant(false);
    if (!j) E('Aucune journée ouverte');
    const r = resumeJour(j);
    if (r.tablesOuvertes && !b.forcer) E('Il reste ' + r.tablesOuvertes + ' table(s) ouverte(s) (' + fmt(r.montantOuvert) + ' DA). Encaissez-les avant la rase.');
    if (j.clos || j.rase) E('Journée déjà clôturée');
    const compte = Math.round(+b.compte);
    if (!(compte >= 0)) E('Indiquez le montant compté');
    const attendu = r.aRemettre;
    const rase = { ts: now(), par: u.nom, compte, attendu, ecart: compte - attendu, completePar: String(b.completePar || ''), commentaire: String(b.commentaire || ''), ca: r.ca, especes: r.especes, cheque: r.cheque, tpe: r.tpe, societe: r.societe, sorties: r.totalSorties, nbTickets: r.nbTickets };
    j.rase = rase; j.clos = now();
    fermerTablesVides(u);
    journal(u, 'rase', 'Journée ' + j.n + ' CA ' + fmt(r.ca) + ' compté ' + fmt(compte) + ' écart ' + fmt(rase.ecart));
    save();
    saveNow();
    const res = await imprimer('ticket', raseDoc(r, rase));
    const erreurs = res.ok ? [] : [res.erreur];
    // envoi automatique de la rase par mail (rangée ensuite dans l'appli de gestion)
    if (db.config.mail && db.config.mail.actif) {
      envoyerRase(j, r, rase).then(m => { j.mailEnvoye = m.ok ? now() : null; j.mailErreur = m.ok ? null : m.erreur; save(); broadcast(); });
    }
    return { rase, resume: r, erreurs };
  },
  'POST /api/admin/mail-test': async (b, u) => {
    if (!peut(u, 'admin')) E('Réservé au responsable', 403);
    const m = db.config.mail || {};
    if (!m.user || !m.pass) E('Indiquez l\'adresse Gmail et le mot de passe d\'application, puis Enregistrer');
    return envoyerMail(m.dest || m.user, '[Caisse MB] Test d\'envoi', 'La caisse La Maison Blanche sait envoyer des mails. Les rases arriveront ici chaque soir.\n');
  },
  'POST /api/rase/renvoyer-mail': async (b, u) => {
    if (!peut(u, 'caissier')) E('Non autorisé', 403);
    const j = db.jours.find(x => x.id === b.jour && x.rase); if (!j) E('Rase introuvable');
    const m = await envoyerRase(j, resumeJour(j), j.rase);
    j.mailEnvoye = m.ok ? now() : null; j.mailErreur = m.ok ? null : m.erreur; save();
    return m;
  },
  'POST /api/rapport-x': async (b, u) => {
    if (!peut(u, 'caissier')) E('Non autorisé', 403);
    const j = jourCourant(false); if (!j) E('Aucune journée ouverte');
    journal(u, 'rapport X', '');
    const res = await imprimer('ticket', raseDoc(resumeJour(j), null));
    return { erreurs: res.ok ? [] : [res.erreur] };
  },
  // vérifie un code sans ouvrir de session (connexion automatique dès que le code est bon)
  'POST /api/code-valide': (b, _u, req) => { const ip = controleEssais(req); const u = parCode(b.pin); const ok = !!u && String(b.pin).length >= 4; if (!ok) echecAcces(ip); else succesAcces(ip); return { ok }; },
  'POST /api/pointage/autoriser': (b, _u, req) => {
    const ip = String(req.socket.remoteAddress || '');
    if (!/^(::1|127\.|::ffff:127\.)/.test(ip)) E('Autorisation uniquement sur la caisse principale', 403);
    const cle = controleEssais(req);
    const caissier = parCode(b.badge || b.pin);
    if (!caissier || !peut(caissier, 'caissier')) {
      echecAcces(cle); E('Code ou badge du caissier incorrect', 401);
    }
    succesAcces(cle);
    for (const [k, v] of autorisationsPointage) if (v.expire < now()) autorisationsPointage.delete(k);
    const autorisation = crypto.randomBytes(24).toString('hex');
    autorisationsPointage.set(autorisation, { ip, caissier: caissier.nom, expire: now() + 60000 });
    return { autorisation, expireDans: 60 };
  },
  'POST /api/pointage': (b, _u, req) => {
    // le pointage se fait seulement sur le PC de la caisse principale (pas sur les écrans de salle)
    const ip = String((req && req.socket && req.socket.remoteAddress) || '');
    if (!/^(::1|127\.|::ffff:127\.)/.test(ip)) E('Le pointage se fait uniquement sur la caisse principale', 403);
    const jeton = String(b.autorisation || '');
    const accord = autorisationsPointage.get(jeton);
    autorisationsPointage.delete(jeton); // usage unique, y compris si le code employé est incorrect
    if (!accord || accord.expire < now() || accord.ip !== ip) E('Autorisation du caissier requise ou expirée', 403);
    const cle = controleEssais(req);
    const u = parCode(b.badge || b.pin);
    if (!u) { echecAcces(cle); E(b.badge ? 'Badge inconnu' : 'Code incorrect', 401); }
    succesAcces(cle);
    const ouvert = db.pointages.find(p => p.userId === u.id && !p.out && now() - p.in < 20 * 3600e3);
    let type, duree = 0;
    if (ouvert) {
      if (now() - ouvert.in < 60000) E(u.nom + ' : arrivée déjà pointée à ' + heure(ouvert.in));
      ouvert.out = now(); type = 'depart'; duree = Math.round((ouvert.out - ouvert.in) / 60000);
    } else {
      db.seq.pointage++;
      db.pointages.push({ id: 'P' + db.seq.pointage, userId: u.id, nom: u.nom, in: now(), out: null });
      type = 'arrivee';
    }
    journal(u, 'pointage', (type === 'arrivee' ? 'arrivée' : 'départ') + ' · autorisé par ' + accord.caissier);
    save();
    return { nom: u.nom, type, heure: heure(now()), duree, autorisePar: accord.caissier };
  },
  'GET /api/admin/pointages': (b, u, req, q) => {
    if (!peut(u, 'admin')) E('Réservé au responsable', 403);
    const du = q.du || '0000', au = q.au || '9999';
    return db.pointages.filter(p => { const d = dateLocale(p.in); return d >= du && d <= au; }).sort((a, b) => a.in - b.in);
  },
  'POST /api/admin/pointage': (b, u) => {
    if (!peut(u, 'admin')) E('Réservé au responsable', 403);
    if (b.nouveau) {
      const x = db.users.find(k => k.id === b.userId); if (!x) E('Personne inconnue');
      db.seq.pointage++; db.pointages.push({ id: 'P' + db.seq.pointage, userId: x.id, nom: x.nom, in: +b.in, out: b.out ? +b.out : null, corrige: u.nom });
    } else {
      const i = db.pointages.findIndex(p => p.id === b.id); if (i < 0) E('Pointage introuvable');
      if (b.supprimer) db.pointages.splice(i, 1);
      else { const p = db.pointages[i]; if (b.in) p.in = +b.in; p.out = b.out ? +b.out : null; p.corrige = u.nom; if (p.out && p.out < p.in) E('Le départ est avant l\'arrivée'); }
    }
    journal(u, 'pointage corrigé', b.id || 'ajout'); save(); return {};
  },
  'GET /api/version': () => ({ version: VERSION }),
  // « calme » = aucune table ouverte et personne n'a touché la caisse depuis 3 minutes (pour installer une mise à jour)
  // 3.4.0 : les tables ouvertes n'empêchent plus la mise à jour (elles sont gardées) ; il suffit que personne n'ait touché la caisse depuis 3 min
  'GET /api/calme': () => { const calme = now() - derniereActivite > 180000; if (calme) { saveNow(); sauverSessions(); } return { calme }; },
  'GET /api/maj': (b, u) => { if (!peut(u, 'admin')) E('Réservé au responsable', 403); return { version: VERSION, app: !!process.send, etat: majEtat }; },
  'POST /api/maj/verifier': (b, u) => { if (!peut(u, 'admin')) E('Réservé au responsable', 403); if (process.send) process.send({ type: 'verifier' }); return {}; },
  'POST /api/maj/installer': (b, u) => {
    if (!peut(u, 'admin')) E('Réservé au responsable', 403);
    journal(u, 'mise à jour', 'installation demandée'); saveNow(); sauverSessions();
    if (process.send) process.send({ type: 'installer' }); return {};
  },
  'POST /api/rase/reimprimer': async (b, u) => {
    if (!peut(u, 'caissier')) E('Non autorisé', 403);
    const j = db.jours.find(x => x.id === b.jour && x.rase);
    if (!j) E('Rase introuvable');
    const res = await imprimer('ticket', raseDoc(resumeJour(j), j.rase));
    return { erreurs: res.ok ? [] : [res.erreur] };
  },

  // ---------------- Administration
  'GET /api/rapport': (b, u, req, q) => {
    if (!peut(u, 'admin')) E('Réservé au responsable', 403);
    const t = dateLocale(now());
    return rapport(q.du || t, q.au || t);
  },
  'GET /api/rapport/lignes': (b, u, req, q) => {
    if (!peut(u, 'admin')) E('Réservé au responsable', 403);
    return rapportLignes(q);
  },
  'GET /api/journal': (b, u) => { if (!peut(u, 'admin')) E('Réservé au responsable', 403); return db.journal.slice(-500).reverse(); },
  'GET /api/admin/users': (b, u) => { if (!peut(u, 'admin')) E('Réservé au responsable', 403); return db.users; },
  'POST /api/admin/users': (b, u) => {
    if (!peut(u, 'admin')) E('Réservé au responsable', 403);
    const list = b.users || [];
    const codes = new Map();
    const unique = (code, nom) => { if (!code) return; if (codes.has(code)) E('Le même code ou badge est utilisé par ' + codes.get(code) + ' et ' + nom); codes.set(code, nom); };
    for (const x of list) {
      if (!x.nom || !/^\d{4,6}$/.test(String(x.pin))) E('Chaque personne doit avoir un nom et un code de 4 à 6 chiffres');
      if (!['admin', 'caissier', 'serveur', 'cuisine'].includes(x.role)) E('Rôle inconnu');
      if (x.actif) { unique(String(x.pin), x.nom); unique(String(x.badge || '').trim(), x.nom); }
    }
    if (!list.some(x => x.actif && x.role === 'admin')) E('Il faut garder au moins un responsable actif');
    db.users = list.map((x, i) => ({ id: x.id || ('u' + now() + i), nom: String(x.nom).slice(0, 30), role: x.role, pin: String(x.pin), badge: String(x.badge || '').trim().slice(0, 64), actif: !!x.actif }));
    journal(u, 'équipe modifiée', db.users.length + ' personnes');
    save(); return db.users;
  },
  'POST /api/admin/carte': (b, u) => {
    if (!peut(u, 'admin')) E('Réservé au responsable', 403);
    if (!Array.isArray(b.categories) || !Array.isArray(b.produits)) E('Données invalides');
    if (Array.isArray(b.options)) db.options = b.options.filter(g => g.nom && Array.isArray(g.choix)).map((g, i) => ({ id: g.id || ('o' + now() + i), nom: String(g.nom).slice(0, 30), obligatoire: !!g.obligatoire, multiple: !!g.multiple, choix: g.choix.filter(ch => ch.nom).map(ch => ({ nom: String(ch.nom).slice(0, 30), prix: Math.max(0, Math.round(+ch.prix || 0)) })) }));
    const gids = new Set(db.options.map(g => g.id));
    db.categories = b.categories.map((c, i) => ({ id: c.id || ('c' + now() + i), nom: String(c.nom), poste: postesBons().includes(c.poste) ? c.poste : postesBons()[0], couleur: /^#[0-9a-f]{6}$/i.test(c.couleur) ? c.couleur : '#efe3cc', suite: Math.max(0, Math.min(5, parseInt(c.suite, 10) || 0)), univers: String(c.univers || 'La carte').slice(0, 20), ordre: i }));
    const partoutAvant = new Set(db.produits.filter(p => p.partout).map(p => p.id));
    const postesAvant = Object.fromEntries(db.produits.filter(p => Array.isArray(p.postes)).map(p => [p.id, p.postes]));
    db.produits = b.produits.filter(p => p.nom && db.categories.some(c => c.id === p.cat)).map((p, i) => ({ id: p.id || ('p' + now() + i), nom: String(p.nom).slice(0, 40), prix: Math.max(0, Math.round(+p.prix || 0)), cat: p.cat, actif: p.actif !== false, options: (p.options || []).filter(g => gids.has(g)), stock: p.stock === null || p.stock === '' || p.stock === undefined ? null : Math.max(0, parseInt(p.stock, 10) || 0), ...((p.partout !== undefined ? p.partout : partoutAvant.has(p.id)) ? { partout: true } : {}), ...((Array.isArray(p.postes) ? p.postes : postesAvant[p.id]) ? { postes: Array.isArray(p.postes) ? p.postes : postesAvant[p.id] } : {}) }));
    // Un article système ne peut pas être supprimé, renommé ou changé de prix depuis Gestion.
    const supplement = db.produits.find(p => p.id === 'supplement-fixe');
    if (supplement) {
      supplement.nom = 'Supplément'; supplement.prix = 500; supplement.actif = true;
      supplement.options = []; supplement.stock = null;
    } else {
      const cat = db.categories.find(c => c.poste === 'cuisine') || db.categories[0];
      if (cat) db.produits.push({ id: 'supplement-fixe', nom: 'Supplément', prix: 500, cat: cat.id, actif: true, options: [], stock: null });
    }
    retirerOptionsSupplement();
    topCache.ts = 0;
    journal(u, 'carte modifiée', db.produits.length + ' articles');
    save(); return {};
  },
  'POST /api/admin/config': (b, u) => {
    if (!peut(u, 'admin')) E('Réservé au responsable', 403);
    if (b.raseAuto !== undefined) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.raseAuto.heure || ''))) E('Heure de rase invalide');
      db.config.raseAuto = { actif: !!b.raseAuto.actif, heure: b.raseAuto.heure, extinction: !!b.raseAuto.extinction };
    }
    const keep = ['nom', 'adresse', 'tel', 'piedTicket', 'fondCaisse', 'tablePatron', 'imprimantes', 'largeur', 'pageCode', 'sansAccents', 'tiroirAuto', 'deconnexionServeurSec', 'salles', 'societes', 'motifsSortie', 'motifsAnnulation', 'commentaires', 'commentairesCommande', 'qrLien', 'qrTexte', 'logoTicket'];
    for (const k of keep) if (b[k] !== undefined) db.config[k] = b[k];
    if (b.mail) {
      const ancien = db.config.mail || {};
      db.config.mail = { actif: !!b.mail.actif, user: String(b.mail.user || '').trim(), dest: String(b.mail.dest || '').trim(),
        pass: !b.mail.pass || /^•+$/.test(b.mail.pass) ? (ancien.pass || '') : String(b.mail.pass).replace(/\s+/g, '') };
    }
    if (!db.config.imprimantes.ticket) db.config.imprimantes.ticket = IMPRIMANTES().ticket;
    if (!postesBons().length) db.config.imprimantes.cuisine = IMPRIMANTES().cuisine;
    for (const s of db.config.salles) { const vus = new Set(); s.tables = (s.tables || []).filter(t => t && t.n && !vus.has(String(t.n)) && vus.add(String(t.n))).map(t => ({ n: String(t.n).slice(0, 8), x: Math.max(0, Math.min(100, +t.x || 0)), y: Math.max(0, Math.min(100, +t.y || 0)) })); }
    db.config.fondCaisse = Math.round(+db.config.fondCaisse || 0);
    journal(u, 'réglages modifiés', Object.keys(b).join(', '));
    save(); return db.config;
  },
  'GET /api/admin/imprimantes-windows': async (b, u) => { if (!peut(u, 'admin')) E('Réservé au responsable', 403); return { liste: await imprimantesWindows(), windows: process.platform === 'win32' }; },
  'POST /api/admin/test-impression': async (b, u) => {
    if (!peut(u, 'admin')) E('Réservé au responsable', 403);
    const p = db.config.imprimantes[b.poste]; if (!p) E('Imprimante inconnue');
    // « Tester le tiroir » : ouvre seulement le tiroir, sans rien imprimer
    if (b.tiroir) return imprimer('ticket', new Doc().drawer());
    const d = new Doc();
    if (b.poste === 'ticket') enteteTicket(d);
    d.center(1).size(2).bold(1).t('TEST').size(0).bold(0).t(p.nom).t(dateH(now())).t('Accents : é è à ç ô œ ù').center(0).line();
    d.lr('Gauche', 'Droite');
    if (b.poste === 'ticket') piedTicket(d);
    d.cut();
    const r = await imprimer(b.poste, d);
    return r;
  },
};

function lireCorps(req) {
  return new Promise((res, rej) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 5e6) { rej(new Err(413, 'Trop gros')); req.destroy(); } });
    req.on('end', () => { try { res(s ? JSON.parse(s) : {}); } catch (e) { rej(new Err(400, 'JSON invalide')); } });
  });
}
function csv(rows) {
  // Empêche qu'un champ libre soit interprété comme formule par un tableur.
  return '\uFEFF' + rows.map(r => r.map(v => {
    v = v == null ? '' : String(v);
    if (/^[\t\r\n ]*[=+@-]/.test(v)) v = "'" + v;
    return /[;"\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }).join(';')).join('\r\n');
}

// Commandes des clients par QR code (3.6.0) : module à part, désactivé tant que le relais n'est pas réglé
const QR = require('./qr.js')({ db: () => db, routes, E, now, save, saveNow, journal, peut, broadcast, salleNom, envoyerLignes, verifierLignes, topVentes, dateLocale, Doc, imprimer, VERSION });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const q = Object.fromEntries(url.searchParams);
  try {
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    if (url.pathname.startsWith('/export/')) {
      // jeton passé dans l'URL pour les téléchargements
      const s = sessions.get(q.t);
      const valide = s && now() - s.ts <= SESSION_IDLE_MS && now() - (s.created || s.ts) <= SESSION_MAX_MS;
      if (s && !valide) sessions.delete(q.t);
      const u = valide && db.users.find(x => x.id === s.userId && x.actif);
      if (!peut(u, 'admin')) E('Réservé au responsable', 403);
      const du = q.du || '0000', au = q.au || '9999';
      let rows, nom;
      if (url.pathname === '/export/tickets.csv') {
        nom = 'tickets'; rows = [['Ticket', 'Date', 'Heure', 'Salle', 'Table', 'Couverts', 'Serveur', 'Caissier', 'Total', 'Remise', 'Net', 'Paiement', 'Société', 'Annulé']];
        for (const t of db.tickets) if (t.date >= du && t.date <= au) rows.push([t.num, t.date, heure(t.ts), salleNom(t.salle), t.table, t.couverts, t.serveur, t.caissier, t.total, t.remise, t.net, paiementsDe(t).map(p => MODES[p.mode] + ' ' + p.montant).join(' + '), [t.societe, t.reference].filter(Boolean).join(' '), t.annule ? 'oui' : '']);
      } else if (url.pathname === '/export/pointages.csv') {
        nom = 'pointages'; rows = [['Nom', 'Date', 'Arrivée', 'Départ', 'Durée (h)', 'Corrigé par']];
        for (const p of db.pointages.slice().sort((a, b) => a.in - b.in)) { const d = dateLocale(p.in); if (d >= du && d <= au) rows.push([p.nom, d, heure(p.in), p.out ? heure(p.out) : '', p.out ? ((p.out - p.in) / 3600000).toFixed(2).replace('.', ',') : '', p.corrige || '']); }
      } else if (url.pathname === '/export/plats.csv') {
        nom = 'plats'; const r = rapport(du, au); rows = [['Plat', 'Catégorie', 'Quantité', 'Montant']]; for (const p of r.plats) rows.push([p.nom, p.cat, p.qte, p.montant]);
      } else if (url.pathname === '/export/rases.csv') {
        nom = 'rases'; rows = [['Journée', 'Date', 'Tickets', 'CA', 'Espèces', 'Chèques', 'TPE', 'Sur facture', 'Sorties', 'Attendu', 'Compté', 'Écart', 'Complété par', 'Caissier']];
        for (const j of db.jours) if (j.rase && j.date >= du && j.date <= au) rows.push([j.n, j.date, j.rase.nbTickets, j.rase.ca, j.rase.especes, j.rase.cheque || 0, j.rase.tpe || 0, j.rase.societe, j.rase.sorties, j.rase.attendu, j.rase.compte, j.rase.ecart, j.rase.completePar, j.rase.par]);
      } else if (url.pathname === '/export/sorties.csv') {
        nom = 'sorties'; rows = [['Date', 'Heure', 'Montant', 'Motif', 'Détail', 'Par']];
        for (const s of db.sorties) if (s.date >= du && s.date <= au) rows.push([s.date, heure(s.ts), s.montant, s.motif, s.detail, s.par]);
      } else if (url.pathname === '/export/sauvegarde.json') {
        saveNow(); res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="caisse-sauvegarde-' + dateLocale(now()) + '.json"' }); return res.end(fs.readFileSync(DB_FILE));
      } else E('Export inconnu', 404);
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="' + nom + '-' + du + '-' + au + '.csv"' });
      return res.end(csv(rows));
    }
    if (url.pathname.startsWith('/api/')) {
      const key = req.method + ' ' + url.pathname;
      const fn = routes[key];
      if (!fn) E('Inconnu', 404);
      const body = req.method === 'POST' ? await lireCorps(req) : {};
      const publique = key === 'POST /api/login' || key === 'POST /api/pointage' || key === 'POST /api/pointage/autoriser' || key === 'POST /api/code-valide' || key === 'GET /api/version' || key === 'GET /api/calme';
      if (req.method === 'POST') derniereActivite = now();
      const u = publique ? null : userDe(req);
      if (!publique && !u) E('Session expirée, reconnectez-vous', 401);
      const out = await fn(body, u, req, q);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(out));
    }
    // fichiers de l'interface
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    const f = path.normalize(path.join(DIR, 'public', p));
    if (!f.startsWith(path.join(DIR, 'public')) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('Introuvable'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    const code = e.code && typeof e.code === 'number' ? e.code : 500;
    if (code === 500) console.error(e);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ erreur: code === 500 ? 'Erreur interne : ' + e.message : e.message }));
  }
});

server.on('error', e => { console.error('Impossible de démarrer : ' + e.message); process.exit(e.code === 'EADDRINUSE' ? 3 : 1); });
server.listen(PORT, '0.0.0.0', () => {
  if (process.send) process.send({ type: 'pret', port: PORT });
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log('');
  console.log('  Caisse La Maison Blanche est lancée.');
  console.log('  Sur ce PC      : http://localhost:' + PORT);
  for (const ip of ips) console.log('  Écrans de salle : http://' + ip + ':' + PORT);
  console.log('  Ne fermez pas cette fenêtre pendant le service.');
  console.log('');
});
