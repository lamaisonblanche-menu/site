'use strict';
// Livraisons du site → caisse (3.8.0). Faux serveur Gmail (IMAP sur TLS) local, base isolée.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const tls = require('node:tls');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');

function mailHtml(sujet, champs) {
  const rows = champs.map(([k, v]) => `<tr><td><strong>${k}</strong></td></tr><tr><td>${v.replace(/\n/g, '<br>')}</td></tr>`).join('');
  return `Message-ID: <${Math.random().toString(36).slice(2)}@web3forms>\r\nFrom: Web3Forms <notify@web3forms.com>\r\nSubject: =?UTF-8?B?${Buffer.from(sujet).toString('base64')}?=\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from('<html><body><table>' + rows + '</table></body></html>').toString('base64')}\r\n`;
}

test('Livraisons du site : lues dans Gmail, validées par le caissier, articles retrouvés', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caisse-liv-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  const aujourdhui = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  const mails = [
    mailHtml('Livraison (à valider seulement si reçue sur WhatsApp) : Karim, 4 500 DA, ' + aujourdhui + ' 20 h 30', [
      ['Commande', '2 × Le Burger bœuf (4 000 DA)\n1 × Coca (250 DA)\n1 × Plat inventé (250 DA)'], ['Sous-total', '4 500 DA (hors frais de livraison)'], ['Paiement', 'Espèces à la livraison'],
      ['Jour', aujourdhui], ['Heure', '20 h 30'], ['Nom', 'Karim'], ['Téléphone', '0550 12 34 56'], ['Adresse', '12 rue des Pins'], ['Commune / quartier', 'Hydra'], ['Remarque', 'Sonner deux fois']]),
    mailHtml('Réservation : 2 pers., test', [['Nom', 'Test']]),
  ];
  const imap = tls.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, sock => {
    sock.write('* OK IMAP pret\r\n');
    let buf = '';
    sock.on('data', d => {
      buf += d; let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 2);
        const [tag, ...rest] = l.split(' '); const c = rest.join(' ');
        if (/^UID SEARCH/.test(c)) sock.write('* SEARCH ' + mails.map((_, k) => k + 1).join(' ') + '\r\n' + tag + ' OK\r\n');
        else if (/^UID FETCH/.test(c)) { const n = +c.split(' ')[2]; const m = Buffer.from(mails[n - 1]); sock.write(`* ${n} FETCH (UID ${n} BODY[] {${m.length}}\r\n`); sock.write(m); sock.write(')\r\n' + tag + ' OK\r\n'); }
        else sock.write(tag + ' OK\r\n');
      }
    });
  });
  await new Promise(ok => imap.listen(0, '127.0.0.1', ok));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn(process.execPath, [path.join(__dirname, '../core/server.js')], { env: { ...process.env, PORT: String(port), CAISSE_DATA: path.join(dir, 'data'), CAISSE_IMAP_HOST: 'localhost', CAISSE_IMAP_PORT: String(imap.address().port), NODE_EXTRA_CA_CERTS: path.join(dir, 'c.pem') }, stdio: 'ignore' });
  const url = 'http://127.0.0.1:' + port;
  let token = '';
  const api = async (e, d, t = token) => { const r = await fetch(url + e, { method: d === undefined ? 'GET' : 'POST', headers: { 'x-token': t, 'content-type': 'application/json' }, ...(d === undefined ? {} : { body: JSON.stringify(d) }) }); return { status: r.status, data: await r.json() }; };
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(url + '/api/version')).ok) break; } catch {} await sleep(100); }
    token = (await api('/api/login', { pin: '1234' }, '')).data.token;
    const cf = await api('/api/admin/config', { mail: { actif: true, user: 'maisonblanchehydra@gmail.com', pass: 'abcd efgh ijkl mnop', dest: 'maisonblanchehydra@gmail.com' } }); assert.equal(cf.status, 200, JSON.stringify(cf.data));
    const lu = await api('/api/reservations/site', {});
    assert.equal(lu.data.erreur, null, JSON.stringify(lu.data));
    let L = (await api('/api/livraisons')).data;
    assert.equal(L.length, 1, 'une seule livraison (le mail de réservation n\'en est pas une)');
    const x = L[0];
    assert.equal(x.nom, 'Karim'); assert.equal(x.tel, '0550 12 34 56'); assert.equal(x.adresse, '12 rue des Pins'); assert.equal(x.commune, 'Hydra');
    assert.equal(x.lignes.length, 3); assert.equal(x.sousTotal, 4500);
    assert.equal(x.lignes[0].article, 'Burger bœuf', 'nom du site retrouvé dans la caisse');
    assert.equal(x.lignes[1].article, 'Coca');
    assert.equal(x.lignes[2].article, null, 'plat inconnu : jamais remplacé par un autre');
    assert.equal((await api('/api/etat')).data.alertes.livraisons, 1, 'alerte à la caisse');
    await api('/api/reservations/site', {});
    assert.equal((await api('/api/livraisons')).data.length, 1, 'pas de doublon à la relecture');
    const acc = await api('/api/livraison/accepter', { id: x.id });
    assert.equal(acc.status, 200, JSON.stringify(acc.data));
    assert.equal(acc.data.commande.salle, 'emporter');
    assert.equal(acc.data.commande.client.nom, 'Karim');
    assert.match(acc.data.commande.note, /LIVRAISON · 12 rue des Pins, Hydra · Sonner deux fois/);
    assert.ok(acc.data.commande.retrait, 'heure de retrait = heure de livraison');
    assert.equal(acc.data.lignes.length, 2); assert.deepEqual(acc.data.manquants, ['1 × Plat inventé']);
    assert.equal((await api('/api/livraison/accepter', { id: x.id })).status, 409, 'pas deux commandes pour la même livraison');
    const et = (await api('/api/etat')).data;
    assert.equal((await api('/api/commande/envoyer', { id: acc.data.commande.id, lignes: acc.data.lignes })).status, 400, 'cuisson obligatoire : le caissier doit la choisir');
    for (const l of acc.data.lignes) { const p = et.produits.find(x => x.id === l.pid); for (const g of p.options || []) { const G = et.options.find(x => x.id === g); if (G && G.obligatoire) l.opts.push({ g: G.id, i: 0 }); } }
    const env = await api('/api/commande/envoyer', { id: acc.data.commande.id, lignes: acc.data.lignes });
    assert.equal(env.status, 200, JSON.stringify(env.data));
    const bons = fs.readdirSync(path.join(dir, 'data', 'impressions-simulees')).map(f => fs.readFileSync(path.join(dir, 'data', 'impressions-simulees', f), 'utf8')).join('\n');
    assert.match(bons, /À EMPORTER/); assert.match(bons, /Karim/);
    assert.equal((await api('/api/etat')).data.alertes.livraisons, 0);
  } finally {
    server.kill('SIGTERM'); imap.close(); await sleep(200);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
