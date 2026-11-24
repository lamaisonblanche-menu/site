// Test de bout en bout : faux relais local + caisse réelle (données de test)
const http = require('http'); const { spawn } = require('child_process'); const fs = require('fs');
const DATA = '/tmp/qrtest'; fs.rmSync(DATA, { recursive: true, force: true });
const PORT = 18181, RP = 18182, SECRET = 'test-secret';
const relais = { cmds: [], acked: new Set(), statuts: {}, carte: null, tables: [], syncs: 0, down: false };
http.createServer((req, res) => {
  let b = ''; req.on('data', x => b += x); req.on('end', () => {
    if (relais.down) { res.writeHead(503); return res.end('{}'); }
    if (req.headers.authorization !== 'Bearer ' + SECRET) { res.writeHead(401); return res.end('{"erreur":"clé"}'); }
    const j = JSON.parse(b); relais.syncs++;
    if (j.carte) relais.carte = j.carte; relais.tables = j.tables; relais.service = j.service;
    for (const id of j.acks) relais.acked.add(id);
    for (const s of j.statuts) relais.statuts[s.id] = s;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ commandes: relais.cmds.filter(c => !relais.acked.has(c.id)), acksOk: j.acks, statutsOk: j.statuts.map(s => s.id) }));
  });
}).listen(RP);
let srv;
function start() { srv = spawn('node', ['app/core/server.js'], { cwd: '/home/claude/site-caisse', env: { ...process.env, CAISSE_DATA: DATA, PORT } }); srv.stdout.on('data', () => {}); srv.stderr.on('data', d => process.stderr.write('[srv] ' + d)); return wait(1500); }
const wait = ms => new Promise(r => setTimeout(r, ms));
async function api(p, body, tok) { const r = await fetch('http://localhost:' + PORT + p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Token': tok || '' }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json(); if (!r.ok) throw new Error(r.status + ' ' + j.erreur); return j; }
const ok = (c, m) => { console.log((c ? '  OK  ' : '  ÉCHEC ') + m); if (!c) process.exitCode = 1; };
(async () => {
  await start();
  const adm = (await api('/api/login', { pin: '1234' })).token, srvTok = (await api('/api/login', { pin: '2000' })).token, cai = (await api('/api/login', { pin: '1009' })).token;
  // 1. envoi classique inchangé
  let e = await api('/api/etat', null, srvTok);
  const viande = e.produits.find(p => (p.options || []).includes('cuisson') && p.actif !== false);
  const dessert = e.produits.find(p => /fondant chocolat/i.test(p.nom));
  let c = await api('/api/commande/ouvrir', { salle: 'brunch', table: '20' }, srvTok);
  try { await api('/api/commande/envoyer', { id: c.id, lignes: [{ pid: viande.id, qte: 1 }] }, srvTok); ok(false, 'cuisson obligatoire refusée'); } catch (x) { ok(/Choisissez/.test(x.message), 'classique : cuisson obligatoire refusée'); }
  let r = await api('/api/commande/envoyer', { id: c.id, lignes: [{ pid: viande.id, qte: 1, opts: [{ g: 'cuisson', i: 2 }] }, { pid: dessert.id, qte: 2 }] }, srvTok);
  ok(r.commande.lignes.length === 2, 'classique : 2 lignes envoyées');
  ok(e.qr && e.qr.actif === false, 'module QR désactivé par défaut');
  // 2. réglages QR + sync
  await api('/api/qr/reglages', { actif: true, relais: 'http://127.0.0.1:' + RP, secret: SECRET, ouverture: '00:00', ouvertureVendredi: '00:00', derniereCommande: '23:59', horaires: { Brunch: ['00:00', '23:59'], Asiatique: ['00:00', '23:59'] } }, adm);
  await wait(4000);
  ok(relais.syncs > 0 && relais.carte && relais.carte.produits.length > 50, 'relais : carte reçue (' + (relais.carte ? relais.carte.produits.length : 0) + ' produits)');
  ok(relais.tables.length === 66, 'relais : 66 tables avec jeton');
  const adminQr = await api('/api/qr/admin', null, adm);
  ok(adminQr.config.secret === '••••••••', 'clé secrète masquée');
  const j105 = relais.tables.find(t => t.salle === 'terrasse' && t.table === '105').jeton;
  // 3. commande QR sur une table fermée
  relais.cmds.push({ id: 'Q1', sid: 's1', type: 'commande', jeton: j105, lignes: [{ pid: viande.id, qte: 1, opts: [{ g: 'cuisson', i: 1 }], note: 'sans sel' }, { pid: dessert.id, qte: 1 }], note: 'anniversaire', ts: Date.now() });
  await wait(3500);
  e = await api('/api/etat', null, srvTok);
  const it = e.qr.attente.find(x => x.id === 'Q1');
  ok(it && it.table === '105' && it.montant === viande.prix + dessert.prix, 'QR reçu, montant calculé par la caisse : ' + (it && it.montant));
  ok(it && it.premiere, 'première commande signalée');
  await wait(3500);
  ok(relais.acked.has('Q1'), 'accusé envoyé au relais');
  // 4. redémarrage avant acceptation : la commande est toujours là
  srv.kill('SIGKILL'); await start();
  e = await api('/api/etat', null, srvTok);
  ok(e.qr.attente.some(x => x.id === 'Q1'), 'après redémarrage brutal : commande toujours en attente');
  // 5. doublon renvoyé par le relais (perte d'accusé)
  relais.acked.delete('Q1'); await wait(3500);
  e = await api('/api/etat', null, srvTok);
  ok(e.qr.attente.filter(x => x.id === 'Q1').length === 1, 'commande renvoyée par le relais : pas de doublon');
  // 6. double acceptation simultanée
  const [a1, a2] = await Promise.allSettled([api('/api/qr/accepter', { id: 'Q1' }, srvTok), api('/api/qr/accepter', { id: 'Q1' }, cai)]);
  ok([a1, a2].filter(x => x.status === 'fulfilled').length === 1, 'double acceptation : une seule passe');
  e = await api('/api/etat', null, srvTok);
  const c105 = e.commandes.find(x => x.salle === 'terrasse' && x.table === '105');
  ok(c105 && c105.lignes.length === 2 && c105.lignes.every(l => l.source === 'qr'), 'table 105 ouverte automatiquement avec 2 lignes QR');
  const imp = fs.readdirSync(DATA + '/impressions-simulees').map(f => fs.readFileSync(DATA + '/impressions-simulees/' + f, 'utf8'));
  ok(imp.some(t => /COMMANDE CLIENT \(QR\)/.test(t) && /TABLE 105/.test(t)), 'bon imprimé avec « COMMANDE CLIENT (QR) »');
  await wait(3500);
  ok(relais.statuts.Q1 && relais.statuts.Q1.statut === 'acceptee', 'statut « acceptée » renvoyé au client');
  // 7. 2e commande même table, ligne invalide (option hors limites) + rupture
  relais.cmds.push({ id: 'Q2', sid: 's2', type: 'commande', jeton: j105, lignes: [{ pid: viande.id, qte: 1, opts: [{ g: 'cuisson', i: 99 }] }], ts: Date.now() });
  relais.cmds.push({ id: 'Q3', sid: 's3', type: 'commande', jeton: j105, lignes: [{ pid: dessert.id, qte: 1 }, { pid: 'inexistant', qte: 1 }], ts: Date.now() });
  relais.cmds.push({ id: 'Q4', sid: 's4', type: 'addition', jeton: j105, lignes: [], ts: Date.now() });
  relais.cmds.push({ id: 'Q5', sid: 's5', type: 'commande', jeton: 'faux0000', lignes: [{ pid: dessert.id, qte: 1 }], ts: Date.now() });
  await wait(3500);
  e = await api('/api/etat', null, srvTok);
  const q2 = e.qr.attente.find(x => x.id === 'Q2'), q5 = e.qr.attente.find(x => x.id === 'Q5');
  ok(q2 && q2.invalide, 'option invalide signalée');
  ok(q5 && q5.alertes.includes('QR code inconnu'), 'QR inconnu signalé');
  try { await api('/api/qr/accepter', { id: 'Q2' }, srvTok); ok(false, 'refus attendu'); } catch (x) { ok(/Option invalide/.test(x.message), 'acceptation d’une commande invalide refusée sans toucher la table'); }
  r = await api('/api/qr/accepter', { id: 'Q3' }, srvTok); ok(r.ok, 'commande avec article supprimé : article ignoré, le reste accepté');
  await api('/api/qr/refuser', { id: 'Q2', motif: 'Cuisson à préciser' }, srvTok);
  r = await api('/api/qr/accepter', { id: 'Q4' }, cai); ok(r.ok, 'demande d’addition : addition imprimée');
  // 8. relais coupé : la caisse continue
  relais.down = true; await wait(3500);
  c = await api('/api/commande/ouvrir', { salle: 'gastro', table: '1' }, srvTok);
  r = await api('/api/commande/envoyer', { id: c.id, lignes: [{ pid: dessert.id, qte: 1 }] }, srvTok);
  ok(r.commande.lignes.length === 1, 'relais coupé : la caisse prend les commandes normalement');
  e = await api('/api/etat', null, srvTok); ok(e.qr.erreur, 'erreur relais visible : ' + e.qr.erreur);
  relais.down = false;
  // 9. pause d'une table
  await api('/api/qr/pause', { salle: 'terrasse', table: '105', pause: true }, cai); await wait(3500);
  ok(relais.tables.find(t => t.jeton === j105).pause, 'pause transmise au relais');
  // 10. encaissement de la table QR
  e = await api('/api/etat', null, cai);
  const c2 = e.commandes.find(x => x.salle === 'terrasse' && x.table === '105');
  const tot = c2.lignes.reduce((s, l) => s + l.qte * l.prix, 0);
  r = await api('/api/commande/encaisser', { id: c2.id, paiements: [{ mode: 'especes', montant: tot }], mode: 'especes', recu: tot }, cai).catch(x => ({ err: x.message }));
  ok(!r.err, 'encaissement de la table QR' + (r.err ? ' : ' + r.err : ''));
  srv.kill(); process.exit();
})().catch(x => { console.error(x); srv && srv.kill(); process.exit(1); });
