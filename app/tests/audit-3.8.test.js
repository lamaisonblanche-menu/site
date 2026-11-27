'use strict';
// Tests de l'audit 3.8.0 : base isolée dans un dossier temporaire, jamais la vraie base du restaurant.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');

function demarrer(dir) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn(process.execPath, [path.join(__dirname, '../core/server.js')], { env: { ...process.env, PORT: String(port), CAISSE_DATA: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; server.stderr.on('data', b => { errors += b; });
  const url = 'http://127.0.0.1:' + port;
  const ctx = { server, url, token: '', errors: () => errors };
  ctx.api = async (endpoint, data, tok = ctx.token) => {
    const res = await fetch(url + endpoint, { method: data === undefined ? 'GET' : 'POST', headers: { 'x-token': tok || '', 'content-type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: res.status, data: await res.json().catch(() => null), headers: res.headers };
  };
  ctx.pret = async () => { for (let i = 0; i < 100; i++) { try { const r = await fetch(url + '/api/version'); if (r.ok) return; } catch {} await sleep(100); } throw new Error('Serveur indisponible ' + errors); };
  return ctx;
}
const lireBase = dir => JSON.parse(fs.readFileSync(path.join(dir, 'caisse.json'), 'utf8'));

test('Audit 3.8.0 : argent, annulations, pointage, tables, sauvegarde, impressions, diagnostic', { timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caisse-audit-'));
  let K = demarrer(dir);
  try {
    await K.pret();
    const admin = (await K.api('/api/login', { pin: '1234' }, '')).data.token;
    K.token = admin;
    const etat = (await K.api('/api/etat')).data;
    const plat = etat.produits.find(p => p.actif && p.id !== 'supplement-fixe' && p.prix >= 1000 && !(p.options || []).some(g => (etat.options.find(x => x.id === g) || {}).obligatoire));
    assert.ok(plat);
    const equipe = (await K.api('/api/admin/users')).data;
    equipe.push({ id: 't-serv', nom: 'Serveur T', pin: '0812', role: 'serveur', actif: true }, { id: 't-cais', nom: 'Caissier T', pin: '0813', role: 'caissier', actif: true });
    assert.equal((await K.api('/api/admin/users', { users: equipe })).status, 200);
    const serv = (await K.api('/api/login', { pin: '0812' }, '')).data.token;
    const cais = (await K.api('/api/login', { pin: '0813' }, '')).data.token;
    const table = async (n, qte = 2, tok = serv) => {
      const o = await K.api('/api/commande/ouvrir', { salle: 'gastro', table: String(n), couverts: 2 }, tok);
      assert.equal(o.status, 200, JSON.stringify(o.data));
      const e = await K.api('/api/commande/envoyer', { id: o.data.id, lignes: [{ pid: plat.id, qte }] }, tok);
      assert.equal(e.status, 200, JSON.stringify(e.data));
      return e.data.commande;
    };
    const P = plat.prix;

    await t.test('Encaissements simples et mixtes', async () => {
      let c = await table(1);
      let r = await K.api('/api/commande/encaisser', { id: c.id, mode: 'especes', recu: 2 * P + 1000, imprimer: false }, cais);
      assert.equal(r.status, 200); assert.equal(r.data.ticket.net, 2 * P); assert.equal(r.data.ticket.rendu, 1000);
      c = await table(2);
      r = await K.api('/api/commande/encaisser', { id: c.id, paiements: [{ mode: 'especes', montant: 500 }, { mode: 'tpe', montant: 2 * P - 500 }], imprimer: false }, cais);
      assert.equal(r.status, 200); assert.equal(r.data.ticket.mode, 'mixte');
      c = await table(3);
      r = await K.api('/api/commande/encaisser', { id: c.id, paiements: [{ mode: 'tpe', montant: 2 * P + 100 }], imprimer: false }, cais);
      assert.equal(r.status, 400, 'la carte ne peut pas dépasser');
      r = await K.api('/api/commande/encaisser', { id: c.id, mode: 'especes', recu: 2 * P - 1, imprimer: false }, cais);
      assert.equal(r.status, 400, 'montant insuffisant refusé');
      r = await K.api('/api/commande/encaisser', { id: c.id, mode: 'especes', recu: 2 * P, imprimer: false }, serv);
      assert.equal(r.status, 403, 'un serveur ne peut pas encaisser');
      r = await K.api('/api/commande/encaisser', { id: c.id, mode: 'societe', societe: 'SPA SARPI', imprimer: false }, cais);
      assert.equal(r.status, 200); assert.equal(r.data.ticket.societe, 'SPA SARPI');
    });

    await t.test('Paiements partiels, partage, double clic', async () => {
      const c = await table(4, 3);
      const l = c.lignes[0];
      const op = { id: c.id, operation: 'd'.repeat(32), lignes: [{ id: l.id, qte: 1 }], mode: 'especes', recu: P, imprimer: false };
      const [a, b] = await Promise.all([K.api('/api/commande/encaisser', op, cais), K.api('/api/commande/encaisser', op, cais)]);
      assert.equal(a.status, 200, JSON.stringify(a.data) + ' / ' + JSON.stringify(b.data)); assert.equal(b.data.ticket.num, a.data.ticket.num, 'double clic = un seul ticket');
      assert.equal(a.data.partiel, true);
      const r = await K.api('/api/commande/encaisser', { id: c.id, lignes: [{ id: l.id, qte: 5 }], mode: 'especes', recu: 5 * P, imprimer: false }, cais);
      assert.equal(r.status, 400, 'quantité trop grande refusée');
      const fin = await K.api('/api/commande/encaisser', { id: c.id, mode: 'tpe', imprimer: false }, cais);
      assert.equal(fin.status, 200); assert.equal(fin.data.ticket.net, 2 * P); assert.equal(fin.data.partiel, false);
    });

    await t.test('Remises, offerts, annulations d\'articles', async () => {
      const c = await table(5);
      // 3.9.4 : le caissier fait la remise sans code ; 3.10.2 : une remise de la totalité demande le code du responsable (= offert)
      let r = await K.api('/api/commande/encaisser', { id: c.id, mode: 'especes', recu: 0, remise: { type: 'pct', valeur: 100 }, imprimer: false }, cais);
      assert.equal(r.status, 403, 'remise de 100 % sans code responsable refusée');
      r = await K.api('/api/commande/encaisser', { id: c.id, mode: 'especes', recu: 0, remise: { type: 'da', valeur: 2 * P }, imprimer: false }, cais);
      assert.equal(r.status, 403, 'remise en DA égale au total sans code responsable refusée');
      r = await K.api('/api/commande/encaisser', { id: c.id, mode: 'especes', recu: 2 * P, remise: { type: 'pct', valeur: 10 }, imprimer: false }, cais);
      assert.equal(r.status, 200, 'remise de 10 % sans code acceptée'); assert.equal(r.data.ticket.net, 2 * P - Math.round(2 * P * 0.1));
      const c2 = await table(6);
      r = await K.api('/api/commande/annuler-ligne', { id: c2.id, ligne: c2.lignes[0].id, qte: 1, motif: 'Erreur' }, serv);
      assert.equal(r.status, 403, 'un serveur seul ne peut pas annuler');
      r = await K.api('/api/commande/annuler-ligne', { id: c2.id, ligne: c2.lignes[0].id, qte: 1, motif: 'Erreur', pin: '0813' }, serv);
      assert.equal(r.status, 200, 'annulation avec le code d\'un caissier');
      r = await K.api('/api/commande/encaisser', { id: c2.id, mode: 'offert', imprimer: false }, cais);
      assert.equal(r.status, 403, 'offert sans code refusé');
      r = await K.api('/api/commande/encaisser', { id: c2.id, mode: 'offert', pin: '1234', imprimer: false }, cais);
      assert.equal(r.status, 200); assert.equal(r.data.ticket.net, 0);
    });

    await t.test('Annulation de ticket : un refus ne touche jamais au CA (bug P1 corrigé)', async () => {
      const c = await table(7);
      const enc = await K.api('/api/commande/encaisser', { id: c.id, mode: 'especes', recu: 2 * P, imprimer: false }, cais);
      const avant = (await K.api('/api/caisse', undefined, cais)).data.resume.ca;
      await table(7, 1); // la table 7 est de nouveau occupée
      const r = await K.api('/api/ticket/annuler', { num: enc.data.ticket.num, motif: 'Test', rouvrir: true, pin: '1234' }, cais);
      assert.equal(r.status, 400);
      const apres = (await K.api('/api/caisse', undefined, cais)).data.resume.ca;
      assert.equal(apres, avant, 'le CA ne doit pas changer après un refus');
      assert.ok(!lireBase(dir).tickets.find(x => x.num === enc.data.ticket.num).annule, 'ticket non annulé sur le disque');
      const ok = await K.api('/api/ticket/annuler', { num: enc.data.ticket.num, motif: 'Test', pin: '1234' }, cais);
      assert.equal(ok.status, 200);
      assert.equal((await K.api('/api/caisse', undefined, cais)).data.resume.ca, avant - 2 * P);
    });

    await t.test('Tables : une table qui n\'existe pas est refusée, comptoir et à emporter restent possibles', async () => {
      assert.equal((await K.api('/api/commande/ouvrir', { salle: 'gastro', table: '999' }, serv)).status, 400);
      assert.equal((await K.api('/api/commande/ouvrir', { salle: 'inconnue', table: '1' }, serv)).status, 400);
      assert.equal((await K.api('/api/commande/ouvrir', { salle: 'emporter', client: { nom: 'A' } }, serv)).status, 200);
      assert.equal((await K.api('/api/commande/ouvrir', { salle: 'comptoir', table: 'C' }, cais)).status, 200);
      const c = await table(8, 1);
      assert.equal((await K.api('/api/commande/modifier', { id: c.id, salle: 'gastro', table: '998' }, cais)).status, 400, 'transfert vers une table inexistante refusé');
    });

    await t.test('Serveurs : accès aux tables des collègues, QR validables par les serveurs (choix du gérant)', async () => {
      const o = await K.api('/api/commande/ouvrir', { salle: 'gastro', table: '9' }, cais);
      const r = await K.api('/api/commande/ouvrir', { salle: 'gastro', table: '9' }, serv);
      assert.equal(r.data.id, o.data.id);
      assert.equal((await K.api('/api/qr/accepter', { id: 'x' }, serv)).status, 404, 'route autorisée au serveur (demande introuvable)');
    });

    await t.test('Pointage : correction vérifiée avant écriture', async () => {
      const n = Date.now();
      let r = await K.api('/api/admin/pointage', { nouveau: true, userId: 't-serv', in: n - 3600e3, out: n - 7200e3 });
      assert.equal(r.status, 400);
      r = await K.api('/api/admin/pointage', { nouveau: true, userId: 't-serv', in: 'abc' });
      assert.equal(r.status, 400);
      r = await K.api('/api/admin/pointage', { nouveau: true, userId: 't-serv', in: n - 7200e3, out: n - 3600e3 });
      assert.equal(r.status, 200);
      const p = lireBase(dir).pointages.slice(-1)[0];
      r = await K.api('/api/admin/pointage', { id: p.id, in: p.in, out: p.in - 60000 });
      assert.equal(r.status, 400);
      const p2 = lireBase(dir).pointages.find(x => x.id === p.id);
      assert.equal(p2.out, p.out, 'le pointage n\'a pas été abîmé');
      assert.equal((await K.api('/api/admin/pointage', { nouveau: true, userId: 't-serv', in: n }, cais)).status, 403);
      // autorisation du pointage : à usage unique
      const aut = await K.api('/api/pointage/autoriser', { pin: '0813' }, '');
      assert.equal(aut.status, 200); assert.equal(aut.data.expireDans, 60);
      assert.equal((await K.api('/api/pointage', { autorisation: aut.data.autorisation, pin: '0812' }, '')).status, 200);
      assert.equal((await K.api('/api/pointage', { autorisation: aut.data.autorisation, pin: '0812' }, '')).status, 403, 'autorisation réutilisée refusée');
      assert.equal((await K.api('/api/pointage/autoriser', { pin: '0812' }, '')).status, 401, 'un serveur ne peut pas autoriser');
    });

    await t.test('Sauvegarde durable : l\'opération est sur le disque dès la réponse', async () => {
      const c = await table(10, 1);
      const r = await K.api('/api/commande/encaisser', { id: c.id, mode: 'especes', recu: P, imprimer: false }, cais);
      assert.ok(lireBase(dir).tickets.some(x => x.num === r.data.ticket.num));
      const s = await K.api('/api/sortie', { montant: 1234, motif: 'Achat' }, cais);
      assert.ok(lireBase(dir).sorties.some(x => x.id === s.data.id), 'sortie de caisse écrite tout de suite');
      const resa = await K.api('/api/reservation', { date: '2026-12-20', heure: '20:00', nom: 'Durable', tel: '0550000000', couverts: 2, salle: 'gastro', table: '3' }, cais);
      assert.equal(resa.status, 200, JSON.stringify(resa.data));
      assert.ok(lireBase(dir).reservations.some(x => x.nom === 'Durable'));
    });

    await t.test('Impressions : échec noté, alerte, réimpression ciblée une seule fois', async () => {
      // imprimante cuisine branchée sur une adresse qui refuse la connexion
      const ferme = net.createServer(); await new Promise(ok => ferme.listen(0, '127.0.0.1', ok)); const portFerme = ferme.address().port; await new Promise(ok => ferme.close(ok));
      const cfg = (await K.api('/api/etat')).data.config;
      const imps = JSON.parse(JSON.stringify(cfg.imprimantes));
      for (const k of Object.keys(imps)) if (k !== 'ticket') { imps[k].ip = '127.0.0.1'; imps[k].port = portFerme; }
      assert.equal((await K.api('/api/admin/config', { imprimantes: imps })).status, 200);
      const o = await K.api('/api/commande/ouvrir', { salle: 'gastro', table: '11' }, serv);
      const e = await K.api('/api/commande/envoyer', { id: o.data.id, lignes: [{ pid: plat.id, qte: 1 }] }, serv);
      assert.equal(e.status, 200);
      const et = (await K.api('/api/etat', undefined, cais)).data;
      assert.ok(et.alertes.impressions >= 1, 'alerte visible à la caisse');
      assert.equal((await K.api('/api/etat', undefined, serv)).data.alertes, null, 'pas d\'alerte caisse chez le serveur');
      const li = (await K.api('/api/impressions', undefined, cais)).data;
      const x = li.echecs[0]; assert.ok(x && x.erreur);
      assert.equal(x.data, undefined, 'les données brutes ne partent pas aux écrans');
      // on rebranche l'imprimante (faux serveur qui reçoit les données)
      const recus = []; const imp = net.createServer(s => s.on('data', d => recus.push(d))); await new Promise(ok => imp.listen(0, '127.0.0.1', ok));
      for (const k of Object.keys(imps)) if (k !== 'ticket') imps[k].port = imp.address().port;
      await K.api('/api/admin/config', { imprimantes: imps });
      const r1 = await K.api('/api/impression/reimprimer', { id: x.id }, cais);
      assert.equal(r1.status, 200); assert.equal(r1.data.ok, true);
      const r2 = await K.api('/api/impression/reimprimer', { id: x.id }, cais);
      assert.equal(r2.status, 409, 'pas de double réimpression');
      await sleep(300); assert.ok(Buffer.concat(recus).length > 20, 'les données du bon sont bien reparties');
      const d = (await K.api('/api/admin/diagnostic/imprimantes', {})).data;
      assert.equal(d.cuisine.etat, 'inconnu', 'imprimante sans réponse d\'état = inconnu, jamais « OK »');
      imp.close();
      assert.equal((await K.api('/api/impression/reimprimer', { id: x.id }, serv)).status, 403);
    });

    await t.test('Diagnostic réservé au responsable et basé sur des contrôles réels', async () => {
      assert.equal((await K.api('/api/admin/diagnostic', undefined, cais)).status, 403);
      const d = (await K.api('/api/admin/diagnostic')).data;
      assert.equal(d.serveur.version, fs.readFileSync(path.join(__dirname, '../core/VERSION'), 'utf8').trim());
      assert.ok(d.base.derniereEcriture > 0 && d.base.copies >= 1);
      assert.ok(Array.isArray(d.imprimantes) && d.imprimantes.length >= 5);
      assert.ok(d.imprimantes.some(p => p.echecs24h > 0));
      assert.equal(d.mail.configure, false);
    });

    await t.test('Rase manuelle : table ouverte bloque, rase unique, calcul de l\'écart', async () => {
      let r = await K.api('/api/rase', { compte: 0 }, cais);
      assert.equal(r.status, 400, 'tables à payer : rase refusée');
      const ouvertes = (await K.api('/api/etat', undefined, cais)).data.commandes.filter(c => c.lignes.some(l => !l.annule && !l.paye));
      for (const c of ouvertes) assert.equal((await K.api('/api/commande/encaisser', { id: c.id, mode: 'tpe', imprimer: false }, cais)).status, 200);
      const res = (await K.api('/api/caisse', undefined, cais)).data.resume;
      r = await K.api('/api/rase', { compte: res.aRemettre - 300 }, cais);
      assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.rase.ecart, -300);
      const r2 = await K.api('/api/rase', { compte: 0 }, cais);
      assert.notEqual(r2.status, 200, 'pas de double clôture');
      assert.ok(lireBase(dir).jours.find(j => j.rase), 'rase écrite sur le disque');
    });

    await t.test('Redémarrage : tickets, tables et sessions gardés', async () => {
      const avant = lireBase(dir);
      const c = await table(12, 1);
      K.server.kill('SIGTERM'); await sleep(300);
      const tokCais = cais;
      K = demarrer(dir); await K.pret();
      const apres = lireBase(dir);
      assert.equal(apres.tickets.length, avant.tickets.length);
      const e = await K.api('/api/etat', undefined, tokCais);
      assert.equal(e.status, 200, 'session gardée après redémarrage');
      assert.ok(e.data.commandes.some(x => x.id === c.id), 'table ouverte gardée');
    });

    await t.test('Mise à jour : la caisse n\'est pas « calme » pendant une opération', async () => {
      await K.api('/api/sortie', { montant: 100, motif: 'Achat' }, cais);
      const r = await K.api('/api/calme', undefined, '');
      assert.equal(r.data.calme, false, 'activité récente = pas d\'installation');
    });
  } finally {
    K.server.kill('SIGTERM'); await sleep(200);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
