'use strict';
// 3.11.0 : « Gâteau d'anniversaire » à prix libre ; Rigatoni au saumon → Tagliatelles au saumon.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');

test('Gâteau d\'anniversaire à prix libre', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caisse-gateau-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn(process.execPath, [path.join(__dirname, '../core/server.js')], { env: { ...process.env, PORT: String(port), CAISSE_DATA: dir }, stdio: 'ignore' });
  const url = 'http://127.0.0.1:' + port;
  const api = async (e, d, tok) => { const r = await fetch(url + e, { method: d === undefined ? 'GET' : 'POST', headers: { 'x-token': tok || '', 'content-type': 'application/json' }, ...(d === undefined ? {} : { body: JSON.stringify(d) }) }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(url + '/api/version')).ok) break; } catch {} await sleep(100); }
    const adm = (await api('/api/login', { pin: '1234' })).data.token;
    const etat = (await api('/api/etat', undefined, adm)).data;
    assert.ok(!etat.produits.some(p => /rigatoni/i.test(p.nom)), 'Rigatoni encore présent');
    const tag = etat.produits.find(p => p.nom === 'Tagliatelles au saumon');
    assert.ok(tag && tag.prix === 2800, 'Tagliatelles au saumon à 2800 DA');
    const g = etat.produits.find(p => p.id === 'gateau-anniv');
    assert.ok(g && g.prixLibre && g.prix === 0);
    const salle = etat.config.salles.find(s => (s.tables || []).some(t => String(t.n) === '17'));
    const c = (await api('/api/commande/ouvrir', { salle: salle.id, table: '17', couverts: 2 }, adm)).data;
    const id = (c.commande || c).id;
    const sans = await api('/api/commande/envoyer', { id, lignes: [{ pid: g.id, qte: 1, opts: [] }] }, adm);
    assert.equal(sans.status, 400, 'sans prix doit être refusé');
    const ok = await api('/api/commande/envoyer', { id, lignes: [{ pid: g.id, qte: 1, opts: [], prix: 3500, note: 'Bougie 30 ans' }, { pid: tag.id, qte: 1, opts: [] }] }, adm);
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    const r = await api('/api/commande/encaisser', { id, paiements: [{ mode: 'especes', montant: 6300 }], imprimer: false }, adm);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.ticket.net, 6300);
  } finally { server.kill(); }
});
