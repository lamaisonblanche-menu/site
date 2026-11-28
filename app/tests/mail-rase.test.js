'use strict';
// 3.11.1 : une rase faite à la main sans internet est gardée et repart toute seule quand le mail remarche.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const tls = require('node:tls');
const { spawn, execFileSync } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');

test('Rase à la main sans internet : le mail part tout seul plus tard, une seule fois', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caisse-mailrase-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  // un port libre, mais rien n'écoute dessus pour l'instant (= pas de serveur mail joignable)
  const libre = net.createServer(); await new Promise(ok => libre.listen(0, '127.0.0.1', ok));
  const smtpPort = libre.address().port; await new Promise(ok => libre.close(ok));
  const recus = [];
  const smtp = tls.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, sock => {
    let buf = '', data = false, msg = '';
    sock.on('error', () => {});
    sock.write('220 pret\r\n');
    sock.on('data', d => {
      buf += d; let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 2);
        if (data) { if (l === '.') { data = false; recus.push(msg); msg = ''; sock.write('250 ok\r\n'); } else msg += l + '\n'; continue; }
        if (/^EHLO/.test(l)) sock.write('250 ok\r\n');
        else if (/^AUTH LOGIN/.test(l)) sock.write('334 VXNlcm5hbWU6\r\n');
        else if (/^(MAIL|RCPT)/.test(l)) sock.write('250 ok\r\n');
        else if (/^DATA/.test(l)) { data = true; sock.write('354 go\r\n'); }
        else if (/^QUIT/.test(l)) { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write(/^[A-Za-z0-9+/=]+$/.test(l) && !sock.user ? ((sock.user = true), '334 UGFzc3dvcmQ6\r\n') : '235 ok\r\n');
      }
    });
  });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn(process.execPath, [path.join(__dirname, '../core/server.js')], { env: { ...process.env, PORT: String(port), CAISSE_DATA: path.join(dir, 'data'), CAISSE_SMTP_HOST: 'localhost', CAISSE_SMTP_PORT: String(smtpPort), CAISSE_IMAP_HOST: 'localhost', CAISSE_IMAP_PORT: '1', NODE_EXTRA_CA_CERTS: path.join(dir, 'c.pem') }, stdio: 'ignore' });
  const url = 'http://127.0.0.1:' + port;
  let token = '';
  const api = async (e, d) => { const r = await fetch(url + e, { method: d === undefined ? 'GET' : 'POST', headers: { 'x-token': token, 'content-type': 'application/json' }, ...(d === undefined ? {} : { body: JSON.stringify(d) }) }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
  const derniere = async () => (await api('/api/caisse')).data.derniereRase;
  const sujets = () => recus.map(m => { const s = (m.match(/^Subject: =\?UTF-8\?B\?(.+)\?=$/m) || [])[1]; return s ? Buffer.from(s, 'base64').toString('utf8') : ''; });
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(url + '/api/version')).ok) break; } catch {} await sleep(100); }
    token = (await api('/api/login', { pin: '1234' })).data.token;
    const cf = await api('/api/admin/config', { mail: { actif: true, user: 'caisse@example.com', pass: 'abcd efgh ijkl mnop', dest: 'patron@example.com' } }); assert.equal(cf.status, 200, JSON.stringify(cf.data));
    const etat = (await api('/api/etat')).data;
    const p = etat.produits.find(x => x.nom === 'Tagliatelles au saumon');
    const c = (await api('/api/commande/ouvrir', { salle: 'gastro', table: '5', couverts: 2 })).data;
    const id = (c.commande || c).id;
    assert.equal((await api('/api/commande/envoyer', { id, lignes: [{ pid: p.id, qte: 1, opts: [] }] })).status, 200);
    assert.equal((await api('/api/commande/encaisser', { id, paiements: [{ mode: 'especes', montant: 2800 }], imprimer: false })).status, 200);

    // rase alors que le serveur mail ne répond pas
    const rase = await api('/api/rase', { compte: 2800 }); assert.equal(rase.status, 200, JSON.stringify(rase.data));
    let d; for (let i = 0; i < 50; i++) { d = await derniere(); if (d && d.mailErreur) break; await sleep(100); }
    assert.ok(d && !d.mailEnvoye, 'la rase ne doit pas être notée envoyée');
    assert.match(d.mailErreur || '', /partira toute seule/);

    // le mail remarche ; un autre mail (réservation) relance la file d'attente
    await new Promise(ok => smtp.listen(smtpPort, '127.0.0.1', ok));
    const demain = new Date(Date.now() + 864e5), dateResa = demain.getFullYear() + '-' + String(demain.getMonth() + 1).padStart(2, '0') + '-' + String(demain.getDate()).padStart(2, '0');
    const resa = await api('/api/reservation', { date: dateResa, heure: '20:00', nom: 'Test', tel: '0550', couverts: 2 }); assert.equal(resa.status, 200, JSON.stringify(resa.data));
    for (let i = 0; i < 80; i++) { d = await derniere(); if (d && d.mailEnvoye && recus.length >= 2) break; await sleep(100); }
    assert.ok(d.mailEnvoye, 'la rase doit être notée envoyée');
    assert.equal(d.mailErreur, null);
    const rases = recus.filter((m, i) => /Rase du/.test(sujets()[i]));
    assert.equal(rases.length, 1, 'un seul mail de rase : ' + JSON.stringify(sujets()));
    const corps = Buffer.from(rases[0].split('\n\n').slice(1).join('').replace(/\s/g, ''), 'base64').toString('utf8');
    const donnees = JSON.parse(corps.match(/DONNEES-CAISSE (\{.*\})/)[1]);
    assert.equal(donnees.ca, 2800); assert.equal(donnees.compte, 2800); assert.equal(donnees.ecart, 0);
    assert.ok(sujets().some(s => /Nouvelle réservation/.test(s)), 'la réservation est partie aussi');

    // « Renvoyer la rase » à la main : envoyée de nouveau, rien ne reste en attente
    const re = await api('/api/rase/renvoyer-mail', { jour: d.id }); assert.equal(re.status, 200); assert.equal(re.data.ok, true);
    const diag = (await api('/api/admin/diagnostic')).data;
    assert.equal(diag.mail.enAttente, 0);
  } finally { server.kill(); smtp.close(); }
});
