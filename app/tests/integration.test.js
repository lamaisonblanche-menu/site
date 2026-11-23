'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');

test('Parcours HTTP complet isolé : connexion, commande, supplément, encaissement et persistance', { timeout: 45000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caisse-integration-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn(process.execPath, [path.join(__dirname, '../core/server.js')], {
    env: { ...process.env, PORT: String(port), CAISSE_DATA: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  server.stderr.on('data', b => { errors += b.toString(); });
  const url = 'http://127.0.0.1:' + port;
  let token = '';
  const api = async (endpoint, data, auth = true) => {
    const res = await fetch(url + endpoint, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { ...(auth ? { 'x-token': token } : {}), 'content-type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: res.status, data: await res.json() };
  };
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) break;
      try { const r = await api('/api/version', undefined, false); if (r.status === 200) { ready = true; break; } } catch {}
      await sleep(100);
    }
    assert.ok(ready, 'Serveur indisponible: ' + errors);
    const login = await api('/api/login', { pin: '1234' }, false);
    assert.equal(login.status, 200);
    token = login.data.token;
    const etat = await api('/api/etat');
    assert.equal(etat.status, 200);
    const product = etat.data.produits.find(p => p.actif && (p.options || []).includes('supplements') && !(p.options || []).some(gid => {
      const g = etat.data.options.find(x => x.id === gid);
      return g && g.obligatoire;
    }));
    assert.ok(product, 'Aucun plat avec supplément facultatif');
    const ouvert = await api('/api/commande/ouvrir', { salle: 'gastro', table: '1', couverts: 2 });
    assert.equal(ouvert.status, 200);
    const id = ouvert.data.id;
    const badQty = await api('/api/commande/envoyer', { id, lignes: [{ pid: product.id, qte: 100 }] });
    assert.equal(badQty.status, 400);
    const sent = await api('/api/commande/envoyer', { id, lignes: [{ pid: product.id, qte: 2, opts: [{ g: 'supplements', i: 0 }] }] });
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
    const state = await api('/api/etat');
    const order = state.data.commandes.find(c => c.id === id);
    assert.ok(order);
    assert.equal(order.lignes.length, 1);
    assert.equal(order.lignes[0].prix, product.prix + 500);
    const enc = await api('/api/commande/encaisser', { id, mode: 'especes', recu: (product.prix + 500) * 2, imprimer: false });
    assert.equal(enc.status, 200, JSON.stringify(enc.data));
    assert.equal(enc.data.ticket.net, (product.prix + 500) * 2);
    const second = await api('/api/commande/encaisser', { id, mode: 'especes', recu: (product.prix + 500) * 2, imprimer: false });
    assert.notEqual(second.status, 200, 'Un paiement répété ne doit pas créer un nouveau ticket');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'caisse.json'), 'utf8'));
    assert.equal(saved.tickets.length, 1);
    assert.equal(saved.tickets[0].net, (product.prix + 500) * 2);
    assert.ok(fs.readdirSync(path.join(dir, 'impressions-simulees')).length > 0, 'Bons simulés absents');
  } finally {
    server.kill('SIGTERM');
    await sleep(150);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
