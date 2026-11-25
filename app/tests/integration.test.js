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
    const product = etat.data.produits.find(p => p.actif && p.id !== 'supplement-fixe' && p.prix > 100 && !(p.options || []).some(gid => {
      const g = etat.data.options.find(x => x.id === gid);
      return g && g.obligatoire;
    }));
    assert.ok(product, 'Aucun plat valide sans option obligatoire');
    assert.ok(!etat.data.options.some(g => g.id === 'supplements'));
    const supplement = etat.data.produits.find(p => p.actif && p.id === 'supplement-fixe');
    assert.equal(supplement?.prix, 500);
    const ouvert = await api('/api/commande/ouvrir', { salle: 'gastro', table: '1', couverts: 2 });
    assert.equal(ouvert.status, 200);
    const id = ouvert.data.id;
    const responsable = token;
    const equipe = (await api('/api/admin/users')).data;
    equipe.push({ id: 'serveur-test', nom: 'Serveur test', pin: '0712', role: 'serveur', actif: true },
      { id: 'serveur-test-long', nom: 'Serveur test long', pin: '071234', role: 'serveur', actif: true },
      { id: 'caissier-test', nom: 'Caissier test', pin: '0713', role: 'caissier', actif: true });
    assert.equal((await api('/api/admin/users', { users: equipe })).status, 200);
    const ambigu = await api('/api/code-valide', { pin: '0712' }, false);
    assert.equal(ambigu.data.confirmer, true);
    assert.equal(ambigu.data.ok, false);
    const long = await api('/api/code-valide', { pin: '071234' }, false);
    assert.equal(long.data.ok, true);
    const serveur = await api('/api/login', { pin: '0712' }, false);
    assert.equal(serveur.data.user.id, 'serveur-test');
    token = serveur.data.token;
    const tableCollegue = (await api('/api/etat')).data.commandes.find(c => c.id === id);
    assert.equal(tableCollegue.serveurId, login.data.user.id);
    assert.equal((await api('/api/commande/ouvrir', { salle: 'gastro', table: '1' })).data.id, id);
    assert.equal((await api('/api/commande/modifier', { id, note: 'Test' })).status, 200);
    assert.equal((await api('/api/commande/modifier', { id, salle: 'gastro', table: '2' })).status, 403);
    assert.equal((await api('/api/maj')).status, 403);
    assert.equal((await api('/api/maj/verifier', {})).status, 403);
    assert.equal((await api('/api/maj/installer', {})).status, 403);
    const caisse = await api('/api/login', { pin: '0713' }, false);
    assert.equal(caisse.data.user.role, 'caissier');
    token = caisse.data.token;
    assert.equal((await api('/api/maj')).status, 200);
    assert.equal((await api('/api/maj/verifier', {})).status, 200);
    assert.equal((await api('/api/maj/installer', {})).status, 200);
    assert.equal((await api('/api/admin/users')).status, 403);
    token = serveur.data.token;
    assert.equal((await api('/api/qr/accepter', { id: 'exemple' })).status, 404); // 3.7.8 : un serveur peut valider (demande introuvable ici)
    assert.equal((await api('/api/qr/refuser', { id: 'exemple' })).status, 404);
    token = responsable;
    const badQty = await api('/api/commande/envoyer', { id, lignes: [{ pid: product.id, qte: 100 }] });
    assert.equal(badQty.status, 400);
    const sansNom = await api('/api/commande/envoyer', { id, lignes: [{ pid: supplement.id, qte: 1 }] });
    assert.equal(sansNom.status, 400);
    token = serveur.data.token;
    const sent = await api('/api/commande/envoyer', { id, lignes: [{ pid: product.id, qte: 2 }, { pid: supplement.id, qte: 2, note: 'Olives' }] });
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
    assert.equal(sent.data.commande.lignes[0].par, serveur.data.user.id);
    token = responsable;
    const state = await api('/api/etat');
    const order = state.data.commandes.find(c => c.id === id);
    assert.ok(order);
    assert.equal(order.lignes.length, 2);
    assert.equal(order.lignes[0].prix, product.prix);
    assert.equal(order.lignes[1].prix, 500);
    assert.match(order.lignes[1].nom, /Olives/);
    const enc = await api('/api/commande/encaisser', { id, mode: 'especes', recu: (product.prix + 500) * 2, imprimer: false });
    assert.equal(enc.status, 200, JSON.stringify(enc.data));
    assert.equal(enc.data.ticket.net, (product.prix + 500) * 2);
    const second = await api('/api/commande/encaisser', { id, mode: 'especes', recu: (product.prix + 500) * 2, imprimer: false });
    assert.notEqual(second.status, 200, 'Un paiement répété ne doit pas créer un nouveau ticket');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'caisse.json'), 'utf8'));
    assert.equal(saved.tickets.length, 1);
    assert.equal(saved.tickets[0].net, (product.prix + 500) * 2);
    assert.ok(fs.readdirSync(path.join(dir, 'impressions-simulees')).length > 0, 'Bons simulés absents');
    // Paiements partiels et mixtes, sans duplication des lignes.
    const open2 = await api('/api/commande/ouvrir', { salle: 'gastro', table: '2', couverts: 1 });
    assert.equal(open2.status, 200);
    const id2 = open2.data.id;
    const envoi = { id: id2, operation: 'a'.repeat(32), lignes: [{ pid: product.id, qte: 2 }] };
    const [sent2, envoiRepete] = await Promise.all([api('/api/commande/envoyer', envoi), api('/api/commande/envoyer', envoi)]);
    assert.equal(sent2.status, 200);
    assert.equal(envoiRepete.status, 200);
    assert.equal(envoiRepete.data.commande.lignes.length, 1);
    const state2 = await api('/api/etat');
    const line2 = state2.data.commandes.find(c => c.id === id2).lignes[0];
    const paiement = { id: id2, operation: 'b'.repeat(32), lignes: [{ id: line2.id, qte: 1 }], mode: 'tpe', imprimer: false };
    const partial = await api('/api/commande/encaisser', paiement);
    assert.equal(partial.status, 200, JSON.stringify(partial.data));
    assert.equal(partial.data.partiel, true);
    const paiementRepete = await api('/api/commande/encaisser', paiement);
    assert.equal(paiementRepete.data.ticket.num, partial.data.ticket.num);
    const unit = product.prix;
    const mixed = await api('/api/commande/encaisser', { id: id2, paiements: [{ mode: 'especes', montant: 100 }, { mode: 'tpe', montant: unit - 100 }], imprimer: false });
    assert.equal(mixed.status, 200, JSON.stringify(mixed.data));
    assert.equal(mixed.data.partiel, false);
    assert.equal(mixed.data.ticket.net, unit);
    const saved2 = JSON.parse(fs.readFileSync(path.join(dir, 'caisse.json'), 'utf8'));
    assert.equal(saved2.tickets.length, 3);
    assert.equal(saved2.tickets.reduce((a, t) => a + t.net, 0), (unit + 500) * 2 + unit * 2);
    // Réservations invalides rejetées.
    const invalidDate = await api('/api/reservation', { date: '2026-02-31', heure: '20:00', nom: 'Test', couverts: 2 });
    assert.equal(invalidDate.status, 400);
    const invalidHour = await api('/api/reservation', { date: '2026-12-01', heure: '29:00', nom: 'Test', couverts: 2 });
    assert.equal(invalidHour.status, 400);
    // Limitation des tentatives de connexion.
    for (let i = 0; i < 10; i++) {
      const failed = await api('/api/login', { pin: '0000' }, false);
      assert.equal(failed.status, 401);
    }
    const blocked = await api('/api/login', { pin: '0000' }, false);
    assert.equal(blocked.status, 429);

  } finally {
    server.kill('SIGTERM');
    await sleep(150);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
