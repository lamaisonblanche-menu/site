// Tests de la recherche de caisse et de l'appairage, contre le vrai serveur de caisse (app/core/server.js)
'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const dgram = require('node:dgram');
const { spawn } = require('node:child_process');
const R = require('../reseau');

async function portLibre() {
  const s = net.createServer();
  await new Promise(ok => s.listen(0, '127.0.0.1', ok));
  const { port } = s.address();
  await new Promise(ok => s.close(ok));
  return port;
}
async function lancerCaisse(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bureau-'));
  const port = await portLibre();
  const enfant = spawn(process.execPath, [path.join(__dirname, '../../app/core/server.js')], { env: { ...process.env, PORT: String(port), CAISSE_DATA: dir }, stdio: 'ignore' });
  t.after(async () => {
    if (enfant.exitCode == null && enfant.signalCode == null) { const fin = new Promise(r => enfant.once('exit', r)); enfant.kill(); await fin; }
    rmSync(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 80; i++) { if (await R.estCaisse('127.0.0.1', port)) break; await new Promise(r => setTimeout(r, 100)); }
  return { adresse: '127.0.0.1', port };
}
const post = (c, route, data, token) => fetch(`http://${c.adresse}:${c.port}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': token || '' }, body: JSON.stringify(data) }).then(r => r.json());

test('calcul des adresses à balayer', () => {
  const a = R.adressesAScanner([{ adresse: '192.168.1.37', masque: '255.255.255.0' }]);
  assert.equal(a.length, 253);
  assert.ok(a.includes('192.168.1.1') && a.includes('192.168.1.254') && !a.includes('192.168.1.37'));
  assert.equal(R.adressesAScanner([{ adresse: '10.0.5.9', masque: '255.255.0.0' }]).length, 253, '/16 : seulement le /24 du PC');
  assert.equal(R.adressesAScanner([{ adresse: '10.0.5.9', masque: '255.255.252.0' }]).length, 1021);
  assert.deepEqual(R.reseauxLocaux({ 'vEthernet (WSL)': [{ family: 'IPv4', address: '172.20.0.1', netmask: '255.255.240.0' }], Ethernet: [{ family: 'IPv4', address: '192.168.1.50', netmask: '255.255.255.0' }, { family: 'IPv4', address: '169.254.3.3', netmask: '255.255.0.0' }] }), [{ adresse: '192.168.1.50', masque: '255.255.255.0' }]);
});

test('détection, appairage par code, reconnexion, changement d’adresse, révocation', async t => {
  const caisse = await lancerCaisse(t);
  // balayage : trouve la caisse parmi des adresses mortes
  const trouves = await R.chercherCaisses({ reseaux: [], port: caisse.port, cibles: ['203.0.113.1', '127.0.0.1', '203.0.113.2'] });
  assert.equal(trouves.length, 1);
  assert.equal(trouves[0].adresse, '127.0.0.1');
  const id = await R.identite(trouves[0]);
  assert.equal(id.appairage, true);
  // demande puis acceptation par le responsable
  const d = await R.demanderAppairage(caisse, 'SRV-MB');
  assert.equal((await R.etatAppairage(caisse, d.demande)).etat, 'attente');
  const admin = (await post(caisse, '/api/login', { pin: '1234' })).token;
  const liste = await post(caisse, '/api/admin/suivi-bureau', { activer: true }, admin);
  assert.equal(liste.demandes[0].code, d.code);
  await post(caisse, '/api/admin/suivi-bureau', { accepter: d.demande }, admin);
  const ok = await R.etatAppairage(caisse, d.demande);
  assert.equal(ok.etat, 'accepte');
  const conf = { caisse: { ...caisse, nom: 'caisse' }, cle: ok.cle };
  // lancement suivant : la caisse est retrouvée tout de suite
  assert.equal((await R.retrouver(conf)).etat, 'ok');
  // la caisse a changé d'adresse (DHCP) : retrouvée par balayage grâce à la clé
  const deplace = await R.retrouver({ ...conf, caisse: { ...conf.caisse, adresse: '203.0.113.9' } }, { reseaux: [], port: caisse.port, cibles: ['127.0.0.1'] });
  assert.equal(deplace.etat, 'ok');
  assert.equal(deplace.caisse.adresse, '127.0.0.1');
  // clé renouvelée par la direction
  await post(caisse, '/api/admin/suivi-bureau', { renouveler: true }, admin);
  assert.equal((await R.retrouver(conf)).etat, 'refusee');
  // caisse éteinte : hors ligne (pas « refusée »)
  assert.equal((await R.retrouver({ ...conf, caisse: { adresse: '203.0.113.9', port: caisse.port } }, { reseaux: [], port: caisse.port, cibles: [] })).etat, 'hors');
});

test('découverte UDP compatible avec la réponse de la caisse principale', async t => {
  const port = await portLibre();
  const s = dgram.createSocket('udp4');
  t.after(() => s.close());
  s.on('message', (m, r) => { if (String(m) === 'MB-CAISSE?') s.send('MB-CAISSE!' + JSON.stringify({ nom: 'CAISSE-PC', port: 8080 }), r.port, r.address); });
  await new Promise(ok => s.bind(port, '127.0.0.1', ok));
  const trouves = await R.diffusion({ portDecouverte: port, reseaux: [{ adresse: '127.0.0.1', masque: '255.255.255.255' }], duree: 600 });
  assert.deepEqual(trouves, [{ adresse: '127.0.0.1', port: 8080, nom: 'CAISSE-PC' }]);
});

test('caisse 3.7.0 (sans appairage par code) : association manuelle proposée', async () => {
  const http = require('node:http');
  const s = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/version') return res.end('{"version":"3.7.0"}');
    res.statusCode = 404; res.end('{"erreur":"Introuvable"}');
  });
  await new Promise(ok => s.listen(0, '127.0.0.1', ok));
  const c = { adresse: '127.0.0.1', port: s.address().port };
  try {
    assert.equal(await R.estCaisse(c.adresse, c.port), '3.7.0');
    assert.equal((await R.identite(c)).appairage, false);
  } finally { s.close(); }
});
