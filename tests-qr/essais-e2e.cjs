'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const { setTimeout: attendre } = require('node:timers/promises');
const { pathToFileURL } = require('node:url');

const racine = path.join(__dirname, '..');
const position = { latitude: 36.7401258, longitude: 3.0481449, accuracy: 15 };
async function jusquA(f) {
  for (let i = 0; i < 80; i++) {
    const resultat = await f().catch(() => null);
    if (resultat) return resultat;
    await attendre(150);
  }
  throw new Error('État attendu non reçu');
}
test('avant-premières de l’activation au retour en caisse', async t => {
  const http = require('node:http'), secret = crypto.randomUUID();
  const { Relais, default: worker } = await import(pathToFileURL(path.join(racine, 'relais/worker.js')).href);
  const data = new Map();
  const storage = {
    async get(key) {
      if (Array.isArray(key)) return new Map(key.filter(k => data.has(k)).map(k => [k, structuredClone(data.get(k))]));
      return structuredClone(data.get(key));
    },
    async put(key, value) {
      for (const [k, v] of typeof key === 'string' ? [[key, value]] : Object.entries(key)) data.set(k, structuredClone(v));
    },
    async list({ prefix }) { return new Map([...data].filter(([k]) => k.startsWith(prefix))); },
    async delete(keys) { for (const k of keys) data.delete(k); },
  };
  const env = { CAISSE_SECRET: secret, RELAIS: { idFromName: x => x, get: () => relais } };
  let relais = new Relais({ storage }, env);
  const serveur = http.createServer(async (req, res) => {
    const morceaux = [];
    for await (const chunk of req) morceaux.push(chunk);
    const result = await worker.fetch(new Request('http://localhost' + req.url, {
      method: req.method, headers: req.headers, ...(req.method === 'POST' ? { body: Buffer.concat(morceaux) } : {}),
    }), env);
    res.writeHead(result.status, Object.fromEntries(result.headers));
    res.end(Buffer.from(await result.arrayBuffer()));
  });
  await new Promise(resolve => serveur.listen(0, '127.0.0.1', resolve));
  t.after(() => serveur.close());
  const rel = 'http://127.0.0.1:' + serveur.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-essais-'));
  const portReservation = http.createServer();
  await new Promise(resolve => portReservation.listen(0, '127.0.0.1', resolve));
  const portCaisse = portReservation.address().port;
  await new Promise(resolve => portReservation.close(resolve));
  const adapt = path.join(dir, 'reseau.cjs');
  fs.writeFileSync(adapt, "const os = require('node:os'); try { os.networkInterfaces(); } catch { os.networkInterfaces = () => ({}); }");
  const caisse = spawn(process.execPath, ['--require', adapt, path.join(racine, 'app/core/server.js')], {
    env: { ...process.env, PORT: String(portCaisse), CAISSE_DATA: dir, TZ: 'Africa/Algiers' }, stdio: 'ignore',
  });
  t.after(async () => {
    if (caisse.exitCode === null && caisse.signalCode === null) {
      const fin = new Promise(resolve => caisse.once('exit', resolve)); caisse.kill(); await fin;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function api(base, route, body, token, adresse = '192.0.2.1') {
    const r = await fetch(base + route, {
      method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-token': token || '', 'cf-connecting-ip': adresse },
      body: body && JSON.stringify(body),
    });
    return { http: r.status, ...await r.json() };
  }
  const pos = (route, body, token) => api('http://127.0.0.1:' + portCaisse, route, body, token);
  const web = (route, body, adresse) => api(rel, route, body, '', adresse);
  const admin = await jusquA(async () => (await pos('/api/login', { pin: '1234' })).token);
  const caissier = (await pos('/api/login', { pin: '1009' })).token;
  const reglages = { actif: true, relais: rel, secret, ouverture: '00:00', ouvertureVendredi: '00:00', derniereCommande: '23:59', horaires: {} };
  assert.equal((await pos('/api/qr/reglages', reglages, admin)).http, 200);
  const q = await pos('/api/qr/admin', null, admin);
  const [t1, t2] = q.tables.map(t => t.jeton);
  const uri = '/api/essais?t=' + encodeURIComponent(t1);
  await jusquA(async () => (await web('/api/carte')).caisseEnLigne);
  assert.deepEqual((await web(uri)).produits, []);
  assert.equal((await pos('/api/qr/reglages', { essais: true }, caissier)).http, 403);
  assert.equal((await pos('/api/qr/reglages', { essais: true }, admin)).http, 200);
  const plats = await jusquA(async () => {
    const r = await web(uri);
    return r.produits?.length === 2 && r.produits;
  });
  assert.deepEqual(plats.map(p => p.prix), [2300, 2800]);
  const carte = await web('/api/carte');
  assert.equal(carte.essais, undefined);
  assert.ok(!carte.produits.some(p => plats.some(essai => essai.id === p.id)));
  assert.deepEqual((await web('/api/essais?t=inconnu')).produits, []);
  const commander = (jeton, appareil, pid) => ({
    t: jeton, sid: crypto.randomUUID(), appareil, type: 'commande', position, lignes: [{ pid, qte: 1 }],
  });
  const cmd1 = commander(t1, 'client-1', plats[0].id), cmd2 = commander(t2, 'client-2', plats[0].id);
  const double = { ...cmd1, sid: crypto.randomUUID(), lignes: [{ pid: plats[0].id, qte: 2 }] };
  assert.equal((await web('/api/commande', double)).http, 409);
  const commandes = await Promise.all([web('/api/commande', cmd1, '192.0.2.1'), web('/api/commande', cmd2, '192.0.2.2')]);
  assert.deepEqual(commandes.map(x => x.http).sort(), [200, 409]);
  const index = commandes.findIndex(x => x.http === 200);
  const recu = commandes[index], original = [cmd1,cmd2][index];
  assert.equal((await web('/api/commande', original)).id, recu.id);
  assert.deepEqual((await web(uri)).produits.map(p => p.prix), [2800]);
  await jusquA(async () => (await pos('/api/etat', null, caissier)).qr?.attente.some(c => c.id === recu.id));
  assert.equal((await pos('/api/qr/accepter', { id: recu.id }, caissier)).http, 200);
  const lien = '/api/commande?id=' + recu.id + '&a=' + original.appareil;
  const accepte = await jusquA(async () => {
    const r = await web(lien);
    return r.statut === 'acceptee' && r;
  });
  assert.equal(accepte.total, 2300);
  assert.equal(accepte.essais.length, 1);
  assert.equal((await web('/api/essais/retour', { id: recu.id, pid: plats[0].id, appareil: 'autre', texte: 'Bon' })).http, 404);
  const commentaire = { id: recu.id, pid: plats[0].id, appareil: original.appareil, texte: 'Très bon pesto.' };
  assert.equal((await web('/api/essais/retour', commentaire)).ok, true);
  assert.equal((await web('/api/essais/retour', commentaire)).ok, true);
  assert.equal((await web(lien)).essais[0].retour, true);
  const retours = await jusquA(async () => {
    const r = await pos('/api/qr/admin', null, admin);
    return r.retoursEssais?.length && r.retoursEssais;
  });
  assert.deepEqual(retours.map(r => r.texte), ['Très bon pesto.']);
  assert.ok(fs.readdirSync(path.join(dir, 'impressions-simulees')).some(n => /cuisine/.test(n)));
  relais = new Relais({ storage }, env);
  await jusquA(async () => (await web('/api/carte')).caisseEnLigne);
  assert.deepEqual((await web(uri)).produits.map(p => p.prix), [2800]);
  const dernier = index === 0 ? t2 : t1;
  const linguine = commander(dernier, 'client-linguine', plats[1].id);
  const boisson = carte.produits.find(p => p.nom === 'Cocktail Maison Blanche');
  assert.ok(boisson);
  const impression = { t: dernier, id: crypto.randomUUID(), produits: [boisson.id] };
  const suivre = action => web('/api/suggestions', { ...impression, action });
  assert.equal((await suivre('affichage')).ok, true);
  assert.equal((await suivre('affichage')).ok, true);
  assert.equal((await suivre('clic')).ok, true);
  assert.equal((await suivre('ajout')).ok, true);
  linguine.suggestion = impression.id;
  linguine.suggestionsAjoutees = [boisson.id];
  linguine.lignes.push({ pid: boisson.id, qte: 1 });
  const l = await web('/api/commande', linguine, '192.0.2.3');
  assert.equal(l.http, 200);
  await jusquA(async () => (await pos('/api/etat', null, caissier)).qr?.attente.some(c => c.id === l.id));
  assert.equal((await pos('/api/qr/accepter', { id: l.id }, caissier)).http, 200);
  const statutLinguine = await jusquA(async () => {
    const r = await web('/api/commande?id=' + l.id + '&a=client-linguine');
    return r.statut === 'acceptee' && r;
  });
  assert.equal(statutLinguine.total, 2800 + boisson.prix);
  const rapport = await jusquA(async () => {
    const r = await pos('/api/qr/admin', null, admin);
    return r.suiviSuggestions?.find(g => g.acceptes === 1);
  });
  assert.deepEqual([rapport.affichages, rapport.clics, rapport.ajouts, rapport.acceptes], [1, 1, 1, 1]);
  assert.deepEqual((await web(uri)).produits, []);
});
