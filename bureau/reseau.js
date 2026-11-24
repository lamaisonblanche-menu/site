// Rapports La Maison Blanche — recherche de la caisse principale et appairage (sans Electron, testable avec Node)
'use strict';
const http = require('http');
const os = require('os');
const dgram = require('dgram');

const PORT_CAISSE = 8080, PORT_DECOUVERTE = 41234;

// Requête HTTP courte vers la caisse. Ne lève jamais : renvoie { ok, status, json } ou { ok: false, hors: true }.
function requete(adresse, port, chemin, { methode = 'GET', corps, cle, delai = 2500 } = {}) {
  return new Promise(fin => {
    const donnees = corps ? Buffer.from(JSON.stringify(corps)) : null;
    const headers = {};
    if (cle) headers.Authorization = 'Bearer ' + cle;
    if (donnees) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = donnees.length; }
    const r = http.request({ host: adresse, port, path: chemin, method: methode, headers, timeout: delai }, res => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', c => { s += c; if (s.length > 2e6) r.destroy(); });
      res.on('end', () => { let json = null; try { json = JSON.parse(s); } catch {} fin({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json }); });
    });
    r.on('timeout', () => r.destroy(new Error('délai dépassé')));
    r.on('error', () => fin({ ok: false, hors: true }));
    if (donnees) r.write(donnees);
    r.end();
  });
}

// Est-ce une caisse La Maison Blanche ? (/api/version est public sur toutes les versions)
async function estCaisse(adresse, port = PORT_CAISSE, delai = 1200) {
  const r = await requete(adresse, port, '/api/version', { delai });
  return r.ok && r.json && typeof r.json.version === 'string' ? r.json.version : null;
}

// Adresses IPv4 du réseau local de ce PC (Wi-Fi ou câble), sans les cartes virtuelles évidentes.
function reseauxLocaux(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const [nom, liste] of Object.entries(interfaces)) {
    if (/vEthernet|VirtualBox|VMware|Hyper-V|WSL|Loopback|docker|tailscale|zerotier/i.test(nom)) continue;
    for (const i of liste || []) {
      if (!i || i.family !== 'IPv4' || i.internal || i.address.startsWith('169.254.')) continue;
      out.push({ adresse: i.address, masque: i.netmask });
    }
  }
  return out;
}
const versNombre = ip => ip.split('.').reduce((n, x) => n * 256 + Number(x), 0);
const versIp = n => [24, 16, 8, 0].map(d => Math.floor(n / 2 ** d) % 256).join('.');

// Adresses à essayer : tout le sous-réseau s'il fait 1024 adresses ou moins, sinon le /24 de ce PC.
function adressesAScanner(reseaux) {
  const cibles = new Set();
  for (const { adresse, masque } of reseaux) {
    let bits = masque.split('.').reduce((n, x) => n + Number(x).toString(2).replace(/0/g, '').length, 0);
    if (bits < 22) bits = 24;
    const taille = 2 ** (32 - bits), base = Math.floor(versNombre(adresse) / taille) * taille;
    for (let n = base + 1; n < base + taille - 1; n++) if (versIp(n) !== adresse) cibles.add(versIp(n));
  }
  return [...cibles];
}

// Balayage TCP du port de la caisse (aucune règle de pare-feu nécessaire sur ce PC).
async function scanner(cibles, { port = PORT_CAISSE, parallele = 96, delai = 900 } = {}) {
  const trouves = [];
  let i = 0;
  async function ouvrier() {
    while (i < cibles.length) {
      const adresse = cibles[i++];
      const version = await estCaisse(adresse, port, delai);
      if (version) trouves.push({ adresse, port, version });
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallele, cibles.length) }, ouvrier));
  return trouves;
}

// Découverte par diffusion UDP, la même que celle des écrans de salle (réponse « MB-CAISSE! »).
function diffusion({ duree = 1800, portDecouverte = PORT_DECOUVERTE, reseaux = reseauxLocaux() } = {}) {
  return new Promise(fin => {
    const trouves = new Map();
    let s;
    try { s = dgram.createSocket({ type: 'udp4', reuseAddr: true }); } catch { return fin([]); }
    s.on('message', (msg, r) => {
      const t = String(msg);
      if (!t.startsWith('MB-CAISSE!')) return;
      let info = {};
      try { info = JSON.parse(t.slice(10)); } catch {}
      trouves.set(r.address, { adresse: r.address, port: Number(info.port) || PORT_CAISSE, nom: info.nom || '' });
    });
    s.on('error', () => {});
    s.bind(() => {
      try { s.setBroadcast(true); } catch {}
      const cibles = new Set(['255.255.255.255']);
      for (const { adresse, masque } of reseaux) {
        const ip = adresse.split('.').map(Number), m = masque.split('.').map(Number);
        cibles.add(ip.map((x, k) => (x & m[k]) | (~m[k] & 255)).join('.'));
      }
      for (const c of cibles) s.send('MB-CAISSE?', portDecouverte, c, () => {});
    });
    setTimeout(() => { try { s.close(); } catch {} fin([...trouves.values()]); }, duree);
  });
}

// Recherche complète : dernière adresse connue, puis diffusion UDP et balayage du réseau en parallèle.
async function chercherCaisses({ connue, reseaux = reseauxLocaux(), port = PORT_CAISSE, portDecouverte = PORT_DECOUVERTE, cibles } = {}) {
  const resultat = new Map();
  if (connue?.adresse) {
    const v = await estCaisse(connue.adresse, connue.port || port);
    if (v) return [{ ...connue, port: connue.port || port, version: v }];
  }
  const [udp, tcp] = await Promise.all([
    diffusion({ reseaux, portDecouverte }),
    scanner(cibles || adressesAScanner(reseaux), { port }),
  ]);
  for (const c of tcp) resultat.set(c.adresse + ':' + c.port, c);
  for (const c of udp) {
    const cle = c.adresse + ':' + c.port, deja = resultat.get(cle);
    if (deja) deja.nom = c.nom;
    else { const v = await estCaisse(c.adresse, c.port); if (v) resultat.set(cle, { ...c, version: v }); }
  }
  return [...resultat.values()];
}

// Ce que sait faire la caisse : 3.7.1+ → appairage par code ; 3.7.0 → clé à saisir à la main.
async function identite(caisse) {
  const r = await requete(caisse.adresse, caisse.port, '/suivi/api/identite');
  if (r.ok && r.json?.logiciel === 'caisse-la-maison-blanche') return r.json;
  return { appairage: false };
}

// Vérifie la clé de lecture. 'ok' | 'refusee' (révoquée ou renouvelée) | 'hors' (caisse injoignable)
async function verifierCle(caisse, cle, delai = 6000) {
  // jour sans vente : réponse légère, la caisse ne calcule presque rien
  const r = await requete(caisse.adresse, caisse.port, '/suivi/api/rapports?du=2000-01-01&au=2000-01-01', { cle, delai });
  if (r.ok) return 'ok';
  if (r.status === 401) return 'refusee';
  if (r.status === 404) return 'ancienne'; // caisse sans module Rapports du bureau
  return 'hors';
}

async function demanderAppairage(caisse, poste) {
  const r = await requete(caisse.adresse, caisse.port, '/suivi/api/appairage', { methode: 'POST', corps: { poste } });
  if (!r.ok) throw new Error(r.json?.erreur || 'La caisse ne répond pas');
  return r.json;
}
async function etatAppairage(caisse, demande) {
  const r = await requete(caisse.adresse, caisse.port, '/suivi/api/appairage?demande=' + encodeURIComponent(demande));
  if (!r.ok) return { etat: r.hors ? 'hors' : 'erreur' };
  return r.json;
}

// Retrouve la caisse associée même si son adresse a changé : c'est la clé qui fait foi.
async function retrouver(conf, options = {}) {
  const connue = conf.caisse;
  const premiere = await verifierCle(connue, conf.cle);
  if (premiere !== 'hors') return { etat: premiere, caisse: connue };
  const caisses = await chercherCaisses({ ...options, connue: null });
  for (const c of caisses) {
    const e = await verifierCle(c, conf.cle);
    if (e === 'ok') return { etat: 'ok', caisse: { ...connue, ...c } };
  }
  if (caisses.length === 1) {
    // une seule caisse sur le réseau et elle refuse la clé : accès retiré
    const e = await verifierCle(caisses[0], conf.cle);
    if (e === 'refusee') return { etat: 'refusee', caisse: { ...connue, ...caisses[0] } };
  }
  return { etat: 'hors', caisse: connue };
}

module.exports = { requete, estCaisse, reseauxLocaux, adressesAScanner, scanner, diffusion, chercherCaisses, identite, verifierCle, demanderAppairage, etatAppairage, retrouver, PORT_CAISSE };
