'use strict';
// 3.8.2 : la table du patron (18) est toujours offerte, sans code, hors chiffre d'affaires.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');

test('Table 18 offerte automatiquement', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caisse-patron-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn(process.execPath, [path.join(__dirname, '../core/server.js')], { env: { ...process.env, PORT: String(port), CAISSE_DATA: dir }, stdio: 'ignore' });
  const url = 'http://127.0.0.1:' + port;
  const api = async (e, d, tok) => { const r = await fetch(url + e, { method: d === undefined ? 'GET' : 'POST', headers: { 'x-token': tok || '', 'content-type': 'application/json' }, ...(d === undefined ? {} : { body: JSON.stringify(d) }) }); return { status: r.status, data: await r.json().catch(() => null) }; };
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(url + '/api/version')).ok) break; } catch {} await sleep(100); }
    const adm = (await api('/api/login', { pin: '1234' })).data.token;
    const etat = (await api('/api/etat', undefined, adm)).data;
    const plat = etat.produits.find(p => p.actif && p.id !== 'supplement-fixe' && p.prix >= 1000 && !(p.options || []).some(g => (etat.options.find(x => x.id === g) || {}).obligatoire));
    const equipe = (await api('/api/admin/users', undefined, adm)).data;
    equipe.push({ id: 't-cais', nom: 'Caissier T', pin: '0813', role: 'caissier', actif: true });
    await api('/api/admin/users', { users: equipe }, adm);
    const cais = (await api('/api/login', { pin: '0813' })).data.token;
    const salle = etat.config.salles.find(s => (s.tables || []).some(t => String(t.n) === '18'));
    const vendre = async (table, paiements) => {
      const c = (await api('/api/commande/ouvrir', { salle: salle.id, table, couverts: 1 }, cais)).data;
      const id = (c.commande || c).id;
      const e = await api('/api/commande/envoyer', { id, lignes: [{ pid: plat.id, qte: 2, opts: [] }] }, cais);
      assert.equal(e.status, 200, JSON.stringify(e.data));
      return api('/api/commande/encaisser', { id, paiements, imprimer: false }, cais);
    };
    // un caissier, sans code responsable, même s'il choisit « espèces »
    const r = await vendre('18', [{ mode: 'especes', montant: 999999 }]);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.ticket.mode, 'offert');
    assert.equal(r.data.ticket.net, 0);
    assert.equal(r.data.ticket.patron, true);
    // une autre table reste normale
    const r2 = await vendre(String(salle.tables.find(t => String(t.n) !== '18').n), [{ mode: 'especes', montant: plat.prix * 2 }]);
    assert.equal(r2.data.ticket.mode, 'especes');
    const z = (await api('/api/caisse', undefined, cais)).data.resume;
    assert.equal(z.ca, plat.prix * 2, 'la table 18 ne compte pas dans le CA');
    assert.equal(z.patron, plat.prix * 2, 'valeur de la table 18 sur sa ligne');
    assert.equal(z.offert, 0, 'la table 18 ne gonfle pas les offerts');
    assert.equal(z.especes, plat.prix * 2);
  } finally { server.kill(); }
});
