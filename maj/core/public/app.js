/* Caisse La Maison Blanche — interface (v2 : plans FrontCash, écran de commande, badges) */
'use strict';
const S = {
  token: localStorage.getItem('mb_token') || '',
  etat: null, view: 'login', salle: localStorage.getItem('mb_salle') || null, cmdId: null, draft: [], cat: null, search: '',
  sel: null, qty: '', adminTab: 'rapports', rapport: null, periode: 'jour', caisse: null, online: true, dragging: false,
};
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jsq = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
const fmt = n => String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const da = n => fmt(n) + ' DA';
const hm = ts => new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const ROLE = { admin: 'Responsable', caissier: 'Caisse', serveur: 'Serveur', cuisine: 'Cuisine' };
const SUITES = ['Direct', 'Entrées', 'Plats', 'Desserts', 'Suite 4', 'Suite 5'];
const MODES = { especes: 'Espèces', cheque: 'Chèque', tpe: 'Carte TPE', societe: 'Facture', offert: 'Offert', mixte: 'Plusieurs modes' };
const LV = { cuisine: 0, serveur: 1, caissier: 2, admin: 3 };
const peut = r => S.etat && LV[S.etat.user.role] >= LV[r];
const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const DECO = { bar: 'Bar', caisse: 'Caisse', wc: 'Toilettes', sapin: 'Sapin', plante: 'Plante', porte: 'Entrée' };
const FONDS = { creme: 'Crème (salle)', damier: 'Damier beige', herbe: 'Terrasse (herbe)' };

// ------------------------------------------------------------ Réseau
async function api(path, body) {
  const opt = { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Token': S.token } };
  if (body) opt.body = JSON.stringify(body);
  let r;
  try { r = await fetch(path, opt); }
  catch (e) { toast('Pas de connexion avec la caisse principale. Vérifiez le réseau.', true); throw e; }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/login') { logout(true); throw new Error(j.erreur); }
  if (!r.ok) { const e = new Error(j.erreur || 'Erreur'); e.status = r.status; throw e; }
  return j;
}
function showErrs(res) { if (res && res.erreurs && res.erreurs.length) toast('⚠ ' + res.erreurs.join(' · ') + ' — rien n’a été imprimé.', true, 7000); }
let tt;
function toast(msg, bad, ms) {
  const t = $('#toast'); t.textContent = msg; t.className = bad ? 'bad' : ''; t.hidden = false;
  clearTimeout(tt); tt = setTimeout(() => (t.hidden = true), ms || (bad ? 5000 : 2200));
}
async function act(fn) { try { return await fn(); } catch (e) { if (e.message) toast(e.message, true); return null; } }

async function refresh() {
  if (!S.token) return;
  try { S.etat = await api('/api/etat'); } catch (e) { return; }
  if (S.view === 'caisse') await loadCaisse();
  if (S.view === 'kds') await loadKds();
  alertesPrets();
  verifierVersion(S.etat.version);
  render();
}
// quand la caisse principale passe à une nouvelle version, chaque écran se recharge tout seul (jamais pendant une saisie)
S.versionChargee = null;
function verifierVersion(v) {
  if (!v) return;
  if (!S.versionChargee) { S.versionChargee = v; return; }
  if (v !== S.versionChargee) S.versionAJour = v;
  if (S.versionAJour && !S.draft.length && $('#modal').hidden && !S.dragging) location.reload();
}
setInterval(() => { fetch('/api/version').then(r => r.json()).then(j => verifierVersion(j.version)).catch(() => {}); }, 60000);
// bip discret (nouveau bon en cuisine, plat prêt)
let actx;
function bip(n = 1) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < n; i++) { const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = 880; o.connect(g); g.connect(actx.destination); const t = actx.currentTime + i * .25; g.gain.setValueAtTime(.25, t); g.gain.exponentialRampToValueAtTime(.001, t + .2); o.start(t); o.stop(t + .21); }
  } catch (e) {}
}
// le serveur est prévenu quand la cuisine a fini un bon de sa table
function alertesPrets() {
  if (!S.etat || !S.etat.prets) return;
  const ids = new Set(S.etat.prets.map(p => p.id));
  if (S._prets && LV[S.etat.user.role] >= 1) {
    const nv = S.etat.prets.filter(p => !S._prets.has(p.id)).filter(p => { const c = S.etat.commandes.find(k => k.id === p.cmdId); return c && (c.serveurId === S.etat.user.id || peut('caissier')); });
    if (nv.length) { const c = S.etat.commandes.find(k => k.id === nv[0].cmdId); toast('🔔 Table ' + (c ? c.table : '') + ' : prêt en ' + nv[0].poste + ' (' + nv[0].lignes.join(', ') + ')', false, 6000); bip(2); }
  }
  S._prets = ids;
}
let es, rt;
function live() {
  if (es) es.close();
  es = new EventSource('/api/events');
  es.onmessage = () => { clearTimeout(rt); rt = setTimeout(refresh, 120); };
  es.onopen = () => { if (!S.online) { S.online = true; refresh(); } };
  es.onerror = () => { S.online = false; render(); };
}

// ------------------------------------------------------------ Lecteur de badges
// Le lecteur se comporte comme un clavier : il « tape » le numéro de la carte très vite puis Entrée.
const scan = { buf: '', last: 0, fast: 0 };
document.addEventListener('keydown', e => {
  const t = performance.now();
  if (e.key === 'Enter') {
    const b = scan.buf, fast = scan.fast; scan.buf = ''; scan.fast = 0;
    if (b.length >= 4 && fast >= b.length - 2) {
      e.preventDefault(); e.stopImmediatePropagation();
      const a = document.activeElement; if (a && a.tagName === 'INPUT' && a.value.endsWith(b)) { a.value = a.value.slice(0, -b.length); a.dispatchEvent(new Event('input')); }
      onBadge(b);
    }
    return;
  }
  if (e.key && e.key.length === 1 && /[0-9A-Za-z]/.test(e.key)) {
    if (t - scan.last > 50) { scan.buf = ''; scan.fast = 0; } else scan.fast++;
    scan.buf += e.key; scan.last = t;
  }
}, true);
function onBadge(code) {
  if (window.__badgeCapture) return window.__badgeCapture(code);
  if (window.__pinCb) { const cb = window.__pinCb; window.__pinCb = null; return cb(code); }
  if ((!S.etat || S.view === 'login') && S.pointage) { pin = ''; return pointer({ badge: code }); }
  if (S.etat && S.view !== 'login' && S.draft.length) return toast('Envoyez ou annulez la commande en cours avant de changer de personne.', true);
  pin = ''; login({ badge: code });
}

// ------------------------------------------------------------ Connexion
let pin = '';
function viewLogin() {
  const P = S.pointage;
  return `<div class="login ${P ? 'pointage' : ''}"><div class="login-in">
    <img src="logo.png" alt="La Maison Blanche">
    <div class="sub">${P ? 'Pointage · arrivée / départ' : 'Caisse'}</div>
    ${S.pointeMsg ? `<div class="pmsg ${S.pointeMsg.type}">${S.pointeMsg.html}</div>` : ''}
    <div class="dots" id="dots">${[0, 1, 2, 3, 4, 5].slice(0, Math.max(4, pin.length)).map(i => `<i class="${i < pin.length ? 'f' : ''}"></i>`).join('')}</div>
    <div class="pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button onclick="A.pinTouch('${n}')">${n}</button>`).join('')}
      <button class="k" onclick="A.pin('C')">Effacer</button><button onclick="A.pinTouch('0')">0</button><button class="k" onclick="A.pin('OK')">${P ? 'Pointer' : 'Entrer'}</button></div>
    <div class="err" id="lerr"></div>
    <div class="hl"><b>Passez votre badge</b> sur le lecteur ou tapez votre code</div>
    <button class="btn ${P ? 'dark' : ''} ptg" onclick="A.modePointage(${P ? 0 : 1})">${P ? '← Retour à la caisse' : '⏱ Pointer mon arrivée / mon départ'}</button>
  </div></div>`;
}
async function pointer(cred) {
  pin = '';
  try {
    const r = await api('/api/pointage', cred);
    const h = r.duree ? ' · ' + Math.floor(r.duree / 60) + ' h ' + String(r.duree % 60).padStart(2, '0') + ' travaillées' : '';
    S.pointeMsg = { type: r.type, html: (r.type === 'arrivee' ? 'Bonjour <b>' + esc(r.nom) + '</b> · arrivée à ' + r.heure : 'Au revoir <b>' + esc(r.nom) + '</b> · départ à ' + r.heure + h) };
    bip(1);
  } catch (e) { S.pointeMsg = { type: 'bad', html: esc(e.message || 'Erreur') }; }
  render();
  clearTimeout(S._pt); S._pt = setTimeout(() => { S.pointeMsg = null; S.pointage = false; if (S.view === 'login') render(); }, 5000);
}
async function login(cred) {
  if (!cred) { cred = { pin }; }
  pin = '';
  try {
    const r = await api('/api/login', cred);
    if (S.token && S.token !== r.token) api('/api/logout', {}).catch(() => {});
    S.token = r.token; localStorage.setItem('mb_token', r.token);
    S.etat = await api('/api/etat');
    closeModal(); S.draft = []; S.sel = null; S.qty = '';
    if (S.view === 'login' || S.view === 'admin' && !peut('admin') || S.view === 'caisse' && !peut('caissier')) S.view = 'tables';
    if (S.view === 'commande' && !S.etat.commandes.find(c => c.id === S.cmdId)) S.view = 'tables';
    if (r.user.role === 'cuisine') { S.view = 'kds'; await loadKds(); } else if (S.view === 'kds' && !peut('caissier')) S.view = 'tables';
    S.pointage = false; S.pointeMsg = null;
    toast('Bonjour ' + r.user.nom);
    render(); touch();
  } catch (e) {
    if (S.view !== 'login' && S.etat) return toast(e.message || 'Badge inconnu', true);
    render(); const d = $('#dots'); if (d) d.classList.add('shake'); const l = $('#lerr'); if (l) l.textContent = e.message || 'Code incorrect';
  }
}
function logout(expired) {
  if (S.token && !expired) api('/api/logout', {}).catch(() => {});
  S.token = ''; localStorage.removeItem('mb_token'); S.etat = null; S.view = 'login'; S.draft = []; S.cmdId = null; S.sel = null; S.qty = ''; pin = '';
  closeModal(); render();
}
let lastTouch = Date.now();
function touch() { lastTouch = Date.now(); }
['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, touch, true));
setInterval(() => {
  if (!S.etat) return;
  const sec = +S.etat.config.deconnexionServeurSec || 0;
  if (S.etat.user.role === 'serveur' && sec > 0 && Date.now() - lastTouch > sec * 1000) {
    if (S.draft.length) return; // jamais pendant une commande en cours de saisie
    logout();
  }
  const c = $('#clock'); if (c) c.textContent = hm(Date.now());
}, 1000);

// ------------------------------------------------------------ Barre du haut
function topbar() {
  const u = S.etat.user, v = S.view;
  return `${S.online ? '' : '<div class="offline">Connexion perdue avec la caisse principale… reconnexion en cours</div>'}
  <div class="top">
    <img src="logo.png" alt="">
    ${u.role !== 'cuisine' ? `<button class="tbtn ${v === 'tables' || v === 'commande' ? 'on' : ''}" onclick="A.go('tables')">Tables</button>` : ''}
    ${peut('caissier') ? `<button class="tbtn ${v === 'caisse' ? 'on' : ''}" onclick="A.go('caisse')">Caisse</button>` : ''}
    ${u.role === 'cuisine' || peut('caissier') ? `<button class="tbtn ${v === 'kds' ? 'on' : ''}" onclick="A.go('kds')">Écran cuisine</button>` : ''}
    ${peut('admin') ? `<button class="tbtn ${v === 'admin' ? 'on' : ''}" onclick="A.go('admin')">Gestion</button>` : ''}
    <div class="who"><span><b>${esc(u.nom)}</b> <span class="role">${ROLE[u.role]}</span></span><span class="clock" id="clock">${hm(Date.now())}</span>
    <button class="tbtn out" onclick="A.logout()">Sortir</button></div>
  </div>`;
}

// ------------------------------------------------------------ Plans de salle
function cmdsSalle(id) { return S.etat.commandes.filter(c => c.salle === id); }
function totalCmd(c) { return c.lignes.reduce((s, l) => s + (l.annule || l.offert || l.paye ? 0 : l.qte * l.prix), 0); }
const enAttente = c => c.lignes.filter(l => !l.annule && !l.paye && l.suite > (c.suite || 0));
const dureeTxt = ts => { const m = Math.round((Date.now() - ts) / 60000); return m < 60 ? m + ' min' : Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0'); };

function planHtml(salle, edit) {
  const cmds = edit ? [] : cmdsSalle(salle.id);
  const g = salle.grille;
  const bg = g ? `background-size:${(200 / g[0]).toFixed(3)}% ${(200 / g[1]).toFixed(3)}%;` : '';
  const tables = salle.tables.map((t, i) => {
    const c = cmds.find(k => k.table === t.n);
    const patron = t.n === String(S.etat.config.tablePatron) ? ' patron' : '';
    let cls = 'ptab' + patron, inner = `<span class="pn">${esc(t.n)}</span>`;
    if (c) {
      cls += ' occ' + (c.additionTs ? ' add' : '') + (c.serveurId === S.etat.user.id ? ' mine' : '');
      inner += `<span class="pm">${fmt(totalCmd(c))}</span><span class="pd">${dureeTxt(c.ouverte)}</span>`;
      if (S.etat.prets.some(p => p.cmdId === c.id)) { cls += ' ring'; inner += '<span class="pb">🔔</span>'; }
      else if (enAttente(c).length) inner += `<span class="pw" title="Suite en attente">⏸</span>`;
    }
    if (edit && adm.selT === i) cls += ' sel';
    const act = edit ? `data-t="${i}"` : (c ? `onclick="A.voir('${c.id}')"` : `onclick="A.ouvrir('${jsq(t.n)}')"`);
    return `<button class="${cls}" ${act} style="left:${t.x}%;top:${t.y}%">${inner}</button>`;
  }).join('');
  const deco = (salle.deco || []).map((d, i) => `<div class="deco d-${d.type}${edit && adm.selD === i ? ' sel' : ''}" ${edit ? `data-d="${i}"` : ''} style="left:${d.x}%;top:${d.y}%"></div>`).join('');
  return `<div class="planwrap"><div class="plan f-${salle.fond || 'creme'}${edit ? ' edit' : ''}" data-ratio="${salle.ratio || 1.6}" style="--t:${salle.taille || 7};${bg}">${deco}${tables}</div></div>`;
}
function fitPlans() {
  document.querySelectorAll('.plan').forEach(p => {
    const w = p.parentElement, R = +p.dataset.ratio || 1.6;
    const W = Math.min(w.clientWidth - 40, (w.clientHeight - 40) * R);
    p.style.width = W + 'px'; p.style.height = (W / R) + 'px';
  });
}
window.addEventListener('resize', fitPlans);

function viewTables() {
  const cfg = S.etat.config;
  if (S.salle !== 'emporter' && !cfg.salles.find(s => s.id === S.salle)) S.salle = cfg.salles[0].id;
  const salle = cfg.salles.find(s => s.id === S.salle);
  const emp = S.etat.commandes.filter(c => c.salle === 'emporter' || c.salle === 'comptoir').sort((a, b) => (a.retrait || a.ouverte) - (b.retrait || b.ouverte));
  const tabs = cfg.salles.map(s => { const n = cmdsSalle(s.id).length; return `<button class="tab ${s.id === S.salle ? 'on' : ''}" onclick="A.salle('${s.id}')">${esc(s.nom)}${n ? `<span class="n">${n}</span>` : ''}</button>`; }).join('')
    + `<button class="tab ${S.salle === 'emporter' ? 'on' : ''}" onclick="A.salle('emporter')">🥡 À emporter${emp.length ? `<span class="n">${emp.length}</span>` : ''}</button>`;
  let body;
  if (S.salle === 'emporter') {
    body = `<div class="main"><div class="row" style="margin-bottom:14px"><button class="btn dark big" onclick="A.nouvelEmporter()">+ Nouvelle commande à emporter</button>${peut('caissier') ? '<button class="btn big" onclick="A.comptoir()">+ Vente rapide au comptoir</button>' : ''}</div>
      <div class="emps">${emp.map(c => { const pret = S.etat.prets.some(p => p.cmdId === c.id); const retard = c.retrait && c.retrait < Date.now(); return `<button class="empc ${pret ? 'pret' : ''} ${retard ? 'retard' : ''}" onclick="A.voir('${c.id}')">
        <div class="et"><b>${c.salle === 'comptoir' ? 'Comptoir' : esc(c.table)}</b>${pret ? '<span>🔔 prêt</span>' : ''}</div>
        <div class="en">${c.salle === 'emporter' ? esc((c.client && c.client.nom) || 'Client') : 'Vente rapide'}${c.client && c.client.tel ? ' · ' + esc(c.client.tel) : ''}</div>
        <div class="er">${c.salle === 'emporter' ? 'Retrait ' + (c.retrait ? hm(c.retrait) : 'dès que possible') : 'depuis ' + hm(c.ouverte)}</div>
        <div class="em num">${da(totalCmd(c))}</div></button>`; }).join('') || '<p class="muted">Aucune commande à emporter en cours.</p>'}</div></div>`;
  } else body = planHtml(salle);
  const occ = S.salle === 'emporter' ? emp.length : cmdsSalle(S.salle).length;
  return topbar() + `<div class="tbar"><div class="tabs">${tabs}</div>
    ${S.salle === 'emporter' ? '' : `<div class="legend"><span><i class="l-libre"></i>Libre</span><span><i class="l-occ"></i>Occupée</span><span><i class="l-add"></i>Addition</span><span><i class="l-mine"></i>Votre table</span><span>🔔 Prêt</span><span>⏸ Suite à réclamer</span><b>${occ} en cours</b></div>`}</div>${body}`;
}

// ------------------------------------------------------------ Commande (écran type FrontCash)
function cmd() { return S.etat.commandes.find(c => c.id === S.cmdId); }
const prod = id => S.etat.produits.find(x => x.id === id) || {};
const catDe = p => S.etat.categories.find(k => k.id === p.cat) || {};
const optsDe = d => (d.opts || []).map(o => { const g = S.etat.options.find(x => x.id === o.g); const ch = g && g.choix[o.i]; return ch ? { nom: ch.nom, prix: ch.prix } : null; }).filter(Boolean);
const prixDraft = d => (prod(d.pid).prix || 0) + optsDe(d).reduce((s, o) => s + o.prix, 0);
const suiteDraft = d => d.suite != null ? d.suite : (catDe(prod(d.pid)).suite || 0);
const optsTxt = os => os.length ? `<small class="o">${os.map(o => esc(o.nom) + (o.prix ? ' +' + fmt(o.prix) : '')).join(' · ')}</small>` : '';
const titreCmd = c => c.salle === 'emporter' ? 'À emporter ' + c.table : c.salle === 'comptoir' ? 'Comptoir' : 'Table ' + c.table;
function universListe() { const u = []; for (const k of S.etat.categories) { const x = k.univers || 'La carte'; if (!u.includes(x)) u.push(x); } return u; }
const SUITE_NOM = s => s === 0 ? 'Direct' : SUITES[s];

// ------------------------------------------------------------ Prise de commande
function viewCommande() {
  const c = cmd();
  if (!c) { S.view = 'tables'; return viewTables(); }
  const caisse = peut('caissier');
  const univs = universListe();
  const top = (S.etat.top || []).filter(id => S.etat.produits.some(p => p.id === id && p.actif));
  if (!S.univ || (S.univ !== '★' && !univs.includes(S.univ)) || (S.univ === '★' && !top.length)) S.univ = top.length ? '★' : univs[0];
  const qd = {}; S.draft.forEach(d => (qd[d.pid] = (qd[d.pid] || 0) + d.qte));
  const tile = p => `<button class="pt ${p.stock === 0 ? 'ep' : ''} ${qd[p.id] ? 'has' : ''}" data-pid="${p.id}" style="--c:${catDe(p).couleur || '#eee'}">
      <span class="pn">${esc(p.nom)}</span><span class="pp num">${p.stock === 0 ? 'ÉPUISÉ' : fmt(p.prix)}</span>
      ${qd[p.id] ? `<span class="q">${qd[p.id]}</span>` : ''}${p.stock > 0 ? `<span class="st">reste ${p.stock}</span>` : ''}${(p.options || []).length ? '<span class="op" title="Options">⚙</span>' : ''}</button>`;
  const q = S.search.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  let cat;
  if (q) {
    const r = S.etat.produits.filter(p => p.actif && p.nom.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(q));
    cat = `<section><h4>Résultats pour « ${esc(S.search)} »</h4><div class="pg">${r.map(tile).join('') || '<p class="muted">Aucun article.</p>'}</div></section>`;
  } else if (S.univ === '★') {
    cat = `<section><h4 style="--c:#e9c46a">★ Les plus vendus (30 derniers jours)</h4><div class="pg">${top.map(prod).map(tile).join('')}</div></section>`;
  } else {
    const cats = S.etat.categories.filter(k => (k.univers || 'La carte') === S.univ);
    cat = (cats.length > 1 ? `<div class="jump">${cats.map(k => `<button style="--c:${k.couleur}" onclick="A.saut('${k.id}')">${esc(k.nom)}</button>`).join('')}</div>` : '')
      + cats.map(k => { const ps = S.etat.produits.filter(p => p.actif && p.cat === k.id); return ps.length ? `<section id="sec-${k.id}"><h4 style="--c:${k.couleur}">${esc(k.nom)}</h4><div class="pg">${ps.map(tile).join('')}</div></section>` : ''; }).join('');
  }

  // ---- ticket, rangé par suite (direct, entrées, plats, desserts)
  const items = c.lignes.map(l => ({ s: l.suite || 0, sent: true, l })).concat(S.draft.map((d, i) => ({ s: suiteDraft(d), sent: false, d, i })));
  const suites = [...new Set(items.map(x => x.s))].sort((a, b) => a - b);
  const ligneS = l => `<div class="tl s ${l.annule ? 'cancel' : ''} ${l.paye ? 'paid' : ''} ${l.offert ? 'off' : ''}" onclick="A.ligneEnvoyee('${l.id}')">
      <span class="tq">${l.qte}</span><span class="tn">${esc(l.nom)}${l.emporter && c.salle !== 'emporter' ? ' <span class="emp">🥡</span>' : ''}${optsTxt(l.opts || [])}${l.note ? `<small class="n">${esc(l.note)}</small>` : ''}${l.annule ? `<small class="n">Annulé : ${esc(l.annule.motif)}</small>` : ''}${l.paye ? `<small class="ok">Payé · ticket ${l.paye}</small>` : ''}</span>
      <span class="tp num">${l.offert ? 'offert' : fmt(l.qte * l.prix)}</span><span class="tok">✓</span></div>`;
  const ligneD = (d, i) => { const p = prod(d.pid); return `<div class="tl d ${S.flash === i ? 'flash' : ''}">
      <button class="qb" onclick="A.dqte(${i},-1)">−</button><span class="tq">${d.qte}</span><button class="qb" onclick="A.dqte(${i},1)">+</button>
      <span class="tn" onclick="A.feuille(${i})">${esc(p.nom)}${d.emporter && c.salle !== 'emporter' ? ' <span class="emp">🥡</span>' : ''}${optsTxt(optsDe(d))}${d.note ? `<small class="n">${esc(d.note)}</small>` : ''}</span><button class="qb ed" onclick="A.feuille(${i})" title="Cuisson, commentaire, à emporter, suite">✎</button>
      <span class="tp num">${fmt(d.qte * prixDraft(d))}</span></div>`; };
  const att = enAttente(c);
  const blocs = suites.map(s => {
    const xs = items.filter(x => x.s === s);
    const attente = s > (c.suite || 0) && s > 0 && xs.some(x => x.sent && !x.l.annule && !x.l.paye);
    return `${suites.length > 1 || attente ? `<div class="ts ${attente ? 'att' : ''}">${SUITE_NOM(s)}${attente ? ' · en attente' : ''}</div>` : ''}${xs.map(x => x.sent ? ligneS(x.l) : ligneD(x.d, x.i)).join('')}`;
  }).join('');
  const totDraft = S.draft.reduce((s, d) => s + d.qte * prixDraft(d), 0);
  const total = totalCmd(c) + totDraft;
  const nbDraft = S.draft.reduce((s, d) => s + d.qte, 0);
  const aPayer = c.lignes.some(l => !l.annule && !l.paye) || S.draft.length;
  const serv = (S.etat.users.find(u => u.id === c.serveurId) || {}).nom || '';
  const salleNom = c.salle === 'comptoir' ? 'Comptoir' : c.salle === 'emporter' ? 'À emporter' : (S.etat.config.salles.find(s => s.id === c.salle) || {}).nom;
  const prochaine = att.length ? SUITES[Math.min(...att.map(l => l.suite))] : '';
  const prets = S.etat.prets.filter(p => p.cmdId === c.id);

  return topbar() + `<div class="oc">
    <div class="tk">
      <div class="tk-h">
        <button class="back" onclick="A.go('tables')">←</button>
        <div class="grow"><div class="tk-t">${esc(titreCmd(c))}</div>
          <div class="tk-s">${c.salle === 'emporter' ? '' : esc(salleNom) + ' · '}<button class="lk" onclick="A.couverts()">${c.couverts} couv.</button> · ${esc(serv)} · ${hm(c.ouverte)}</div></div>
        <button class="ib ${c.note ? 'on' : ''}" onclick="A.noteCmd()" title="Note pour toute la commande">💬</button>
        <button class="ib" onclick="A.menuCmd()" title="Plus d'actions">⋯</button>
      </div>
      ${c.salle === 'emporter' ? `<div class="tk-b emp" onclick="A.infosEmporter()">🥡 <b>${esc((c.client && c.client.nom) || 'Client')}</b>${c.client && c.client.tel ? ' · ' + esc(c.client.tel) : ''} · retrait ${c.retrait ? hm(c.retrait) : 'dès que possible'} <span class="lk">modifier</span></div>` : ''}
      ${c.note ? `<div class="tk-b note" onclick="A.noteCmd()">💬 ${esc(c.note)}</div>` : ''}
      ${prets.length ? `<div class="tk-b pret">🔔 Prêt : ${prets.map(p => esc(p.lignes.join(', '))).join(' — ')}<button class="btn sm ok" onclick="A.servi()">Servi</button></div>` : ''}
      ${att.length ? `<div class="tk-b wait">⏸ ${prochaine} en attente<button class="btn sm blue" onclick="A.reclamer()">Réclamer ${prochaine.toLowerCase()}</button></div>` : ''}
      <div class="tk-l">${blocs || '<div class="vide">Touchez les plats à droite pour les ajouter.<br><small>Appui long sur un plat = commentaire, à emporter, suite…</small></div>'}</div>
      <div class="tk-f">
        <div class="tk-tot"><span>Total</span><b class="num">${fmt(total)} <small>DA</small></b></div>
        <div class="tk-a">
          <button class="b-env" onclick="A.envoyer()" ${S.draft.length ? '' : 'disabled'}>Envoyer${nbDraft ? ' <span>' + nbDraft + '</span>' : ''}</button>
          ${caisse ? `<button class="b-cash" onclick="A.payer()" ${aPayer ? '' : 'disabled'}>Encaisser</button>` : `<button class="b-add" onclick="A.addition()" ${c.lignes.some(l => !l.annule && !l.paye) ? '' : 'disabled'}>🧾 Addition</button>`}
        </div>
      </div>
    </div>
    <div class="ca">
      <div class="ca-h"><div class="srch"><input placeholder="🔍 Rechercher un plat…" value="${esc(S.search)}" oninput="A.search(this.value)" id="srch">${S.search ? '<button onclick="A.search(\'\')">✕</button>' : ''}</div></div>
      <div class="uv">${top.length ? `<button class="${S.univ === '★' && !q ? 'on' : ''}" onclick="A.univ('★')">★ Top</button>` : ''}${univs.map(u => `<button class="${S.univ === u && !q ? 'on' : ''}" onclick="A.univ('${jsq(u)}')">${esc(u)}</button>`).join('')}</div>
      <div class="cat" id="cat">${cat}</div>
    </div>
  </div>`;
}

// ---- appui court = ajouter, appui long = ajouter avec commentaire / options
let lp = null;
document.addEventListener('pointerdown', e => {
  const t = e.target.closest('.pt[data-pid]'); if (!t || S.view !== 'commande') return;
  lp = { pid: t.dataset.pid, fired: false, x: e.clientX, y: e.clientY, tm: setTimeout(() => { lp.fired = true; A.add(lp.pid, true); }, 480) };
});
document.addEventListener('pointermove', e => { if (lp && Math.abs(e.clientX - lp.x) + Math.abs(e.clientY - lp.y) > 12) { clearTimeout(lp.tm); lp.cancel = true; } });
document.addEventListener('pointerup', e => {
  if (!lp) return; clearTimeout(lp.tm);
  const t = e.target.closest('.pt[data-pid]');
  if (!lp.fired && !lp.cancel && t && t.dataset.pid === lp.pid) A.add(lp.pid);
  lp = null;
});
document.addEventListener('contextmenu', e => { if (e.target.closest('.pt')) e.preventDefault(); });

// ---- petit clavier à l'écran (écrans tactiles sans clavier)
function clavier(id) {
  const rangs = ['1234567890', 'azertyuiop', 'qsdfghjklm', 'wxcvbn\'-,.', 'éèàçù'];
  return `<div class="kb">${rangs.map(r => `<div>${[...r].map(k => `<button onclick="A.kb('${id}','${k === "'" ? "\\'" : k}')">${k}</button>`).join('')}${r.startsWith('w') ? `<button class="w2" onclick="A.kb('${id}','⌫')">⌫</button>` : ''}</div>`).join('')}<div><button class="sp" onclick="A.kb('${id}',' ')">espace</button><button class="w2" onclick="A.kb('${id}','C')">Effacer</button></div></div>`;
}

// ------------------------------------------------------------ Écran cuisine
async function loadKds() { const r = await api('/api/kds?poste=tous').catch(() => null); if (!r) return; const nv = r.bons.filter(b => b.etat === 'a_faire' && S._kdsIds && !S._kdsIds.has(b.id) && (S.kdsPoste === 'tous' || !S.kdsPoste || b.poste === S.kdsPoste)); if (nv.length) bip(nv.some(b => b.type === 'annulation') ? 3 : 1); S._kdsIds = new Set(r.bons.map(b => b.id)); S.kds = r; }
function viewKds() {
  const K = S.kds;
  if (!K) return topbar() + '<div class="main">Chargement…</div>';
  S.kdsPoste = S.kdsPoste || localStorage.getItem('mb_kds') || 'tous';
  const postes = Object.entries(S.etat.config.imprimantes).filter(([k]) => k !== 'ticket');
  const bons = K.bons.filter(b => S.kdsPoste === 'tous' || b.poste === S.kdsPoste);
  const nomP = k => (S.etat.config.imprimantes[k] || {}).nom || k;
  const card = b => {
    const m = Math.floor((Date.now() - b.ts) / 60000);
    const lvl = b.etat === 'attente' ? 'att' : b.etat === 'pret' ? 'ok' : m >= 20 ? 'r' : m >= 10 ? 'o' : 'v';
    return `<div class="kc k-${lvl} t-${b.type}">
      <div class="kh"><b>${b.type === 'message' ? '✉ ' : b.type === 'annulation' ? '✕ ' : ''}${b.emporter ? '🥡 ' + esc(b.table) + (b.client && b.client.nom ? ' ' + esc(b.client.nom) : '') : 'Table ' + esc(b.table)}</b><span class="kt">${b.etat === 'pret' ? 'prêt ' + hm(b.pretTs) : m + ' min'}</span></div>
      <div class="ks">${esc(b.salle)} · ${esc(b.serveur)}${b.couverts ? ' · ' + b.couverts + ' couv.' : ''}${S.kdsPoste === 'tous' ? ' · ' + esc(nomP(b.poste)) : ''}</div>
      ${b.type === 'commande' && b.suite ? `<div class="ksu">${b.reclame ? 'RÉCLAMÉ · ' : ''}${SUITES[b.suite]}${b.etat === 'attente' ? ' · attendre la réclame' : ''}</div>` : ''}
      ${b.type === 'annulation' ? '<div class="ksu bad">ANNULATION</div>' : ''}
      ${b.emporter ? `<div class="ksu emp">À EMPORTER · retrait ${b.retrait ? hm(b.retrait) : 'dès que possible'}</div>` : ''}
      ${b.note ? `<div class="knote">💬 ${esc(b.note)}</div>` : ''}
      <ul>${b.lignes.map(l => `<li><b>${l.qte}</b> ${esc(l.nom)}${(l.opts || []).map(o => `<i>+ ${esc(o)}</i>`).join('')}${l.emporter && !b.emporter ? '<i class="emp">🥡 à emporter</i>' : ''}${l.note ? `<em>${esc(l.note)}</em>` : ''}</li>`).join('')}</ul>
      ${b.etat === 'a_faire' ? `<button class="kbtn" onclick="A.kPret('${b.id}')">${b.type === 'commande' ? 'PRÊT' : 'VU'}</button>` : b.etat === 'pret' ? `<button class="kbtn ghost" onclick="A.kRappel('${b.id}')">Rappeler</button>` : ''}
    </div>`;
  };
  const afaire = bons.filter(b => b.etat === 'a_faire').sort((a, b) => a.ts - b.ts);
  const attente = bons.filter(b => b.etat === 'attente').sort((a, b) => a.ts - b.ts);
  const prets = bons.filter(b => b.etat === 'pret').sort((a, b) => b.pretTs - a.pretTs);
  return topbar() + `<div class="tbar"><div class="tabs">${[['tous', 'Tous les postes'], ...postes.map(([k, p]) => [k, p.nom])].map(([k, n]) => `<button class="tab ${S.kdsPoste === k ? 'on' : ''}" onclick="A.kPoste('${k}')">${esc(n)}<span class="n">${K.bons.filter(b => b.etat === 'a_faire' && (k === 'tous' || b.poste === k)).length || ''}</span></button>`).join('')}</div>
    <div class="legend"><button class="btn sm" onclick="A.ruptures(S.kdsPoste)">Ruptures / épuisés</button></div></div>
    <div class="kds">${afaire.map(card).join('') || '<p class="muted kvide">Aucun bon en cours 👍</p>'}
      ${attente.length ? `<div class="ksep">En attente de réclame</div>${attente.map(card).join('')}` : ''}
      ${prets.length ? `<div class="ksep">Prêts (20 dernières minutes)</div>${prets.map(card).join('')}` : ''}</div>`;
}
function rupturesModal(poste) {
  const list = S.etat.produits.filter(p => p.actif && (!poste || poste === 'tous' || (catDe(p).poste === poste)));
  const groupes = S.etat.categories.filter(c => list.some(p => p.cat === c.id));
  modal(mh('Ruptures et quantités restantes') + `<p class="muted">« Épuisé » bloque l’article pour les serveurs. Une quantité (ex. 5) se décompte toute seule à chaque commande.</p>
    <div class="rup">${groupes.map(g => `<h4>${esc(g.nom)}</h4>${list.filter(p => p.cat === g.id).map(p => `<div class="rr ${p.stock === 0 ? 'ep' : ''}"><span class="grow">${esc(p.nom)}</span>
      <span class="pill ${p.stock === 0 ? 'bad' : p.stock > 0 ? 'warn' : 'ok'}">${p.stock === 0 ? 'épuisé' : p.stock > 0 ? 'reste ' + p.stock : 'disponible'}</span>
      <input type="number" min="0" inputmode="numeric" placeholder="qté" id="st_${p.id}" style="width:70px"><button class="btn sm" onclick="A.stk('${p.id}',$('#st_${p.id}').value)">OK</button>
      ${p.stock === 0 ? `<button class="btn sm ok" onclick="A.stk('${p.id}',null)">Disponible</button>` : `<button class="btn sm bad" onclick="A.stk('${p.id}',0)">Épuisé</button>`}${p.stock > 0 ? `<button class="btn sm ghost" onclick="A.stk('${p.id}',null)">Illimité</button>` : ''}</div>`).join('')}`).join('')}</div>`, true);
  S._rupPoste = poste;
}
// ------------------------------------------------------------ Caisse
async function loadCaisse() { S.caisse = await api('/api/caisse').catch(() => S.caisse); }
function viewCaisse() {
  const C = S.caisse;
  if (!C) return topbar() + '<div class="main">Chargement…</div>';
  const r = C.resume;
  const ouvertes = S.etat.commandes;
  return topbar() + `<div class="main">
    ${r ? `<div class="muted" style="margin-bottom:10px">Journée n° ${r.jour.n} ouverte le ${new Date(r.jour.ouvert).toLocaleDateString('fr-FR')} à ${hm(r.jour.ouvert)}</div>
    <div class="cards">
      <div class="card hl"><div class="k">Chiffre d'affaires</div><div class="v num">${da(r.ca)}</div></div>
      <div class="card"><div class="k">Espèces</div><div class="v num">${da(r.especes)}</div></div>
      <div class="card"><div class="k">Chèques</div><div class="v num">${da(r.cheque)}</div></div>
      <div class="card"><div class="k">Carte TPE</div><div class="v num">${da(r.tpe)}</div></div>
      <div class="card"><div class="k">Sur facture</div><div class="v num">${da(r.societe)}</div></div>
      <div class="card"><div class="k">Sorties</div><div class="v num">${da(r.totalSorties)}</div></div>
      <div class="card"><div class="k">Tickets · couverts</div><div class="v num">${r.nbTickets} · ${r.couverts}</div></div>
      <div class="card"><div class="k">Tables ouvertes</div><div class="v num">${r.tablesOuvertes} · ${da(r.montantOuvert)}</div></div>
    </div>` : `<div class="panel"><h3>Aucune journée en cours</h3><p class="muted">La journée s’ouvre automatiquement à la première commande.${C.derniereRase ? ' Dernière rase : journée n° ' + C.derniereRase.n + ', le ' + new Date(C.derniereRase.clos).toLocaleString('fr-FR') + '.' : ''}</p></div>`}
    <div class="row" style="margin-bottom:14px">
      <button class="btn dark" onclick="A.comptoir()">+ Vente comptoir</button>
      <button class="btn" onclick="A.sortie()">Sortie de caisse</button>
      <button class="btn" onclick="A.tiroir()">Ouvrir le tiroir</button>
      <button class="btn" onclick="A.rapportX()" ${r ? '' : 'disabled'}>Rapport X</button>
      ${C.derniereRase ? `<button class="btn" onclick="A.reZ('${C.derniereRase.id}')">Réimprimer la dernière rase</button>` : ''}
      <button class="btn gold" style="margin-left:auto" onclick="A.rase()" ${r ? '' : 'disabled'}>Rase de fin de journée</button>
    </div>
    <div class="cols">
      <div class="panel"><h3>Tables à encaisser</h3>
        ${ouvertes.length ? `<table class="l"><tr><th>Table</th><th>Serveur</th><th>Depuis</th><th class="r">Reste</th></tr>
        ${ouvertes.map(c => `<tr onclick="A.voir('${c.id}')" style="cursor:pointer"><td><b>${c.salle === 'comptoir' ? 'Comptoir' : esc(c.table)}</b> ${c.additionTs ? '<span class="pill warn">addition</span>' : ''}</td><td>${esc((S.etat.users.find(u => u.id === c.serveurId) || {}).nom || '')}</td><td>${hm(c.ouverte)}</td><td class="r num">${da(totalCmd(c))}</td></tr>`).join('')}</table>` : '<p class="muted">Aucune table ouverte.</p>'}
      </div>
      <div class="panel"><h3>Sorties de caisse</h3>
        ${r && r.sorties.length ? `<table class="l"><tr><th>Heure</th><th>Motif</th><th class="r">Montant</th><th></th></tr>${r.sorties.map(s => `<tr><td>${hm(s.ts)}</td><td>${esc(s.motif)}<div class="muted" style="font-size:13px">${esc(s.detail)} · ${esc(s.par)}</div></td><td class="r num">${da(s.montant)}</td><td class="r"><button class="btn sm ghost" onclick="A.supSortie('${s.id}')">✕</button></td></tr>`).join('')}</table>` : '<p class="muted">Aucune sortie.</p>'}
      </div>
    </div>
    <div class="panel"><h3>Tickets de la journée</h3>
      ${C.tickets.length ? `<table class="l"><tr><th>N°</th><th>Heure</th><th>Table</th><th>Serveur</th><th>Paiement</th><th class="r">Montant</th><th></th></tr>
      ${C.tickets.map(t => `<tr class="${t.annule ? 'x' : ''}"><td>${t.num}</td><td>${hm(t.ts)}</td><td>${t.salle === 'comptoir' ? 'Comptoir' : esc(t.table)}${t.patron ? ' ★' : ''}${t.partiel ? ' <span class="pill">partiel</span>' : ''}</td><td>${esc(t.serveur)}</td><td>${MODES[t.mode] || t.mode}${t.societe ? ' · ' + esc(t.societe) : ''}${t.reference ? ' · ' + esc(t.reference) : ''}${t.remise ? ' <span class="pill">remise ' + fmt(t.remise) + '</span>' : ''}</td><td class="r num">${da(t.net)}</td>
        <td class="r" style="white-space:nowrap">${t.annule ? '<span class="pill bad">annulé</span>' : `<button class="btn sm" onclick="A.dup(${t.num})">Duplicata</button> <button class="btn sm ghost" onclick="A.annTicket(${t.num})">Annuler</button>`}</td></tr>`).join('')}</table>` : '<p class="muted">Aucun ticket pour le moment.</p>'}
    </div></div>`;
}

// ------------------------------------------------------------ Gestion (admin)
const TABS = [['rapports', 'Rapports'], ['carte', 'Carte et prix'], ['equipe', 'Équipe, codes et badges'], ['salles', 'Plans de salle'], ['imprimantes', 'Imprimantes'], ['pointage', 'Pointage'], ['reglages', 'Réglages'], ['journal', 'Journal']];
let adm = {};
function viewAdmin() {
  const t = S.adminTab;
  const tabs = TABS.map(([k, n]) => `<button class="tab ${k === t ? 'on' : ''}" onclick="A.atab('${k}')">${n}</button>`).join('');
  let body = '';
  try { body = ({ rapports: admRapports, carte: admCarte, equipe: admEquipe, salles: admSalles, imprimantes: admImpr, pointage: admPointage, reglages: admReglages, journal: admJournal })[t](); } catch (e) { body = '<p>Chargement…</p>'; console.error(e); }
  if (t === 'salles') return topbar() + `<div class="tbar"><div class="tabs">${tabs}</div></div>${body}`;
  return topbar() + `<div class="main"><div class="tabs" style="margin-bottom:14px">${tabs}</div>${body}</div>`;
}
function periode(p) {
  const d = new Date(), t = ymd(d);
  if (p === 'jour') return [t, t];
  if (p === 'hier') { d.setDate(d.getDate() - 1); return [ymd(d), ymd(d)]; }
  if (p === '7j') { const a = new Date(); a.setDate(a.getDate() - 6); return [ymd(a), t]; }
  if (p === 'mois') return [t.slice(0, 8) + '01', t];
  if (p === 'moisp') { const a = new Date(d.getFullYear(), d.getMonth() - 1, 1), b = new Date(d.getFullYear(), d.getMonth(), 0); return [ymd(a), ymd(b)]; }
  return [S.du || t, S.au || t];
}
function admRapports() {
  const R = S.rapport;
  const per = [['jour', 'Aujourd’hui'], ['hier', 'Hier'], ['7j', '7 jours'], ['mois', 'Ce mois'], ['moisp', 'Mois dernier']];
  const [du, au] = periode(S.periode);
  const exp = n => `/export/${n}.csv?t=${S.token}&du=${du}&au=${au}`;
  let h = `<div class="row" style="margin-bottom:14px">${per.map(([k, n]) => `<button class="chip ${S.periode === k ? 'on' : ''}" onclick="A.periode('${k}')">${n}</button>`).join('')}
    <input type="date" value="${du}" onchange="A.perso('du',this.value)" class="dt"> → <input type="date" value="${au}" onchange="A.perso('au',this.value)" class="dt"></div>`;
  if (!R) return h + '<p>Chargement…</p>';
  const bars = (o, lab) => { const m = Math.max(1, ...Object.values(o)); return `<div class="bars">${Object.entries(o).map(([k, v]) => `<div class="bar"><span>${esc(lab ? lab(k) : k)}</span><div class="b" style="width:${Math.max(2, v / m * 100)}%"></div><span class="r num">${fmt(v)}</span></div>`).join('') || '<p class="muted">Rien sur la période.</p>'}</div>`; };
  h += `<div class="cards">
    <div class="card hl"><div class="k">Chiffre d'affaires</div><div class="v num">${da(R.ca)}</div></div>
    <div class="card"><div class="k">Espèces</div><div class="v num">${da(R.especes)}</div></div>
    <div class="card"><div class="k">Chèques</div><div class="v num">${da(R.cheque)}</div></div>
    <div class="card"><div class="k">Carte TPE</div><div class="v num">${da(R.tpe)}</div></div>
    <div class="card"><div class="k">Sur facture</div><div class="v num">${da(R.societe)}</div></div>
    <div class="card"><div class="k">Tickets · ticket moyen</div><div class="v num">${R.nbTickets} · ${fmt(R.ticketMoyen)}</div></div>
    <div class="card"><div class="k">Couverts</div><div class="v num">${R.couverts}</div></div>
    <div class="card"><div class="k">Remises · offerts</div><div class="v num">${fmt(R.remises)} · ${fmt(R.offert)}</div></div>
    <div class="card"><div class="k">Sorties de caisse</div><div class="v num">${da(R.sorties)}</div></div>
    <div class="card"><div class="k">Période précédente</div><div class="v num">${da(R.precedent)}</div><div class="muted" style="font-size:13px">${R.precedent ? (R.ca >= R.precedent ? '▲ +' : '▼ ') + Math.round((R.ca - R.precedent) / R.precedent * 100) + ' %' : ''} (${R.precedentDu.slice(8, 10)}/${R.precedentDu.slice(5, 7)} → ${R.precedentAu.slice(8, 10)}/${R.precedentAu.slice(5, 7)})</div></div>
    ${Object.entries(R.tempsPrep || {}).map(([k, v]) => `<div class="card"><div class="k">Préparation ${esc(k)}</div><div class="v num">${v} min</div><div class="muted" style="font-size:13px">temps moyen</div></div>`).join('')}</div>
  <div class="cols">
    <div class="panel"><h3>CA par jour</h3>${bars(R.jours, k => new Date(k + 'T12:00').toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }))}</div>
    <div class="panel"><h3>CA par groupe</h3>${bars(Object.fromEntries(Object.entries(R.categories).sort((a, b) => b[1] - a[1])))}</div>
    <div class="panel"><h3>CA par serveur</h3>${bars(R.serveurs)}</div>
    <div class="panel"><h3>CA par heure</h3>${bars(R.heures, k => k + ' h')}</div>
  </div>
  <div class="panel"><h3>Plats vendus <a class="btn sm" href="${exp('plats')}">Exporter</a></h3>
    <table class="l"><tr><th>#</th><th>Plat</th><th>Groupe</th><th class="r">Quantité</th><th class="r">Montant</th></tr>
    ${R.plats.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.nom)}</td><td class="muted">${esc(p.cat)}</td><td class="r num">${p.qte}</td><td class="r num">${da(p.montant)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Rien sur la période.</td></tr>'}</table></div>
  <div class="panel"><h3>Rases <a class="btn sm" href="${exp('rases')}">Exporter</a></h3>
    <table class="l"><tr><th>Journée</th><th>Date</th><th>Caissier</th><th class="r">CA</th><th class="r">Sorties</th><th class="r">Attendu</th><th class="r">Compté</th><th class="r">Écart</th></tr>
    ${R.rases.map(r => `<tr><td>${r.n}</td><td>${r.date}</td><td>${esc(r.par)}</td><td class="r num">${fmt(r.ca)}</td><td class="r num">${fmt(r.sorties)}</td><td class="r num">${fmt(r.attendu)}</td><td class="r num">${fmt(r.compte)}</td><td class="r num"><span class="pill ${r.ecart ? 'bad' : 'ok'}">${r.ecart > 0 ? '+' : ''}${fmt(r.ecart)}</span>${r.completePar ? '<div class="muted" style="font-size:12px">' + esc(r.completePar) + '</div>' : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">Aucune rase sur la période.</td></tr>'}</table></div>
  <div class="row"><a class="btn" href="${exp('tickets')}">Exporter les tickets</a><a class="btn" href="${exp('sorties')}">Exporter les sorties</a></div>`;
  return h;
}
const postes = () => Object.entries((adm.cfg || S.etat.config).imprimantes).filter(([k]) => k !== 'ticket');
function admCarte() {
  if (!adm.carte) adm.carte = { categories: JSON.parse(JSON.stringify(S.etat.categories)), produits: JSON.parse(JSON.stringify(S.etat.produits)), options: JSON.parse(JSON.stringify(S.etat.options || [])) };
  const C = adm.carte;
  const optHtml = `<div class="panel"><h3>Options des plats <span class="muted" style="font-size:14px;font-family:var(--f-b)">cuisson, accompagnement, suppléments payants…</span><button class="btn sm" onclick="A.addOpt()">+ Groupe d’options</button></h3>
    ${C.options.map((g, gi) => `<div class="og"><div class="row"><input class="hin" value="${esc(g.nom)}" onchange="A.oset(${gi},'nom',this.value)">
      <label class="chk"><input type="checkbox" ${g.obligatoire ? 'checked' : ''} onchange="A.oset(${gi},'obligatoire',this.checked)"> Obligatoire</label>
      <label class="chk"><input type="checkbox" ${g.multiple ? 'checked' : ''} onchange="A.oset(${gi},'multiple',this.checked)"> Plusieurs choix</label>
      <span class="grow"></span><button class="btn sm ghost" onclick="A.delOpt(${gi})">Supprimer</button></div>
      <div class="chips">${g.choix.map((ch, ci) => `<span class="ch"><input value="${esc(ch.nom)}" onchange="A.chset(${gi},${ci},'nom',this.value)"><input type="number" value="${ch.prix}" title="Supplément (DA)" onchange="A.chset(${gi},${ci},'prix',+this.value)"><button onclick="A.delCh(${gi},${ci})">✕</button></span>`).join('')}<button class="chip" onclick="A.addCh(${gi})">+ choix</button></div>
      <p class="muted" style="font-size:13px;margin:0">Utilisé par : ${C.produits.filter(p => (p.options || []).includes(g.id)).map(p => esc(p.nom)).join(', ') || 'aucun plat (cochez-le sur les plats ci-dessous)'}</p></div>`).join('') || '<p class="muted">Aucune option.</p>'}</div>`;
  return `<div class="row" style="margin-bottom:12px"><p class="muted grow">Chaque groupe a sa couleur, son imprimante et sa <b>suite</b> (Direct = part tout de suite, Entrées, Plats, Desserts : les plats attendent que le serveur « réclame »). Stock vide = illimité.</p><button class="btn" onclick="A.addCat()">+ Groupe</button><button class="btn dark" onclick="A.saveCarte()">Enregistrer la carte</button></div>
  <datalist id="univs">${[...new Set(C.categories.map(k => k.univers).filter(Boolean))].map(u => `<option value="${esc(u)}">`).join('')}</datalist>
  ${optHtml}
  ${C.categories.map((k, ci) => `<div class="panel" style="border-left:8px solid ${k.couleur}"><h3><input value="${esc(k.nom)}" onchange="A.cset(${ci},'nom',this.value)" class="hin">
    <input type="color" value="${k.couleur || '#efe3cc'}" onchange="A.cset(${ci},'couleur',this.value);A.rr()" class="col" title="Couleur du bouton">
    <input list="univs" value="${esc(k.univers || '')}" onchange="A.cset(${ci},'univers',this.value)" class="hsel" style="width:130px" title="Onglet de la prise de commande" placeholder="Onglet">
    <select onchange="A.cset(${ci},'poste',this.value)" class="hsel">${postes().map(([pk, p]) => `<option value="${pk}" ${k.poste === pk ? 'selected' : ''}>→ ${esc(p.nom)}</option>`).join('')}</select>
    <select onchange="A.cset(${ci},'suite',+this.value)" class="hsel">${SUITES.slice(0, 4).map((n, i) => `<option value="${i}" ${(k.suite || 0) === i ? 'selected' : ''}>${n}</option>`).join('')}</select>
    <button class="btn sm" onclick="A.addProd('${k.id}')">+ Article</button><button class="btn sm ghost" onclick="A.mvCat(${ci},-1)">↑</button><button class="btn sm ghost" onclick="A.mvCat(${ci},1)">↓</button></h3>
    <table class="l"><tr><th>Article</th><th style="width:120px">Prix (DA)</th><th>Options</th><th style="width:90px">Stock</th><th style="width:70px">Visible</th><th style="width:50px"></th></tr>
    ${C.produits.map((p, pi) => p.cat !== k.id ? '' : `<tr class="${p.actif ? '' : 'x'}"><td><input value="${esc(p.nom)}" onchange="A.pset(${pi},'nom',this.value)"></td><td><input type="number" inputmode="numeric" value="${p.prix}" onchange="A.pset(${pi},'prix',+this.value)"></td>
      <td>${C.options.map(g => `<button class="chip sm ${(p.options || []).includes(g.id) ? 'on' : ''}" onclick="A.popt(${pi},'${g.id}')">${esc(g.nom)}</button>`).join(' ')}</td>
      <td><input type="number" min="0" placeholder="∞" value="${p.stock == null ? '' : p.stock}" onchange="A.pset(${pi},'stock',this.value===''?null:+this.value)"></td>
      <td><input type="checkbox" style="width:26px;height:26px" ${p.actif ? 'checked' : ''} onchange="A.pset(${pi},'actif',this.checked)"></td><td><button class="btn sm ghost" onclick="A.delProd(${pi})">✕</button></td></tr>`).join('')}</table></div>`).join('')}
  <button class="btn dark" onclick="A.saveCarte()">Enregistrer la carte</button>`;
}
function admPointage() {
  const [du, au] = periode(S.periode);
  const per = [['jour', 'Aujourd’hui'], ['hier', 'Hier'], ['7j', '7 jours'], ['mois', 'Ce mois'], ['moisp', 'Mois dernier']];
  let h = `<div class="row" style="margin-bottom:14px">${per.map(([k, n]) => `<button class="chip ${S.periode === k ? 'on' : ''}" onclick="S.periode='${k}';A.atab('pointage')">${n}</button>`).join('')}
    <input type="date" value="${du}" onchange="A.perso('du',this.value,'pointage')" class="dt"> → <input type="date" value="${au}" onchange="A.perso('au',this.value,'pointage')" class="dt">
    <span class="grow"></span><button class="btn" onclick="A.ptAdd()">+ Ajouter</button><a class="btn" href="/export/pointages.csv?t=${S.token}&du=${du}&au=${au}">Exporter</a></div>
    <p class="muted">Chacun pointe en passant son badge après avoir touché « Pointer mon arrivée / mon départ » sur l’écran de connexion. Vous pouvez corriger les heures ici.</p>`;
  if (!adm.pointages) return h + '<p>Chargement…</p>';
  const parNom = {};
  for (const p of adm.pointages) (parNom[p.nom] = parNom[p.nom] || []).push(p);
  const t = ts => { const d = new Date(ts); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const dur = m => Math.floor(m / 60) + ' h ' + String(Math.round(m % 60)).padStart(2, '0');
  h += Object.entries(parNom).map(([nom, ps]) => {
    const total = ps.reduce((s, p) => s + (p.out ? (p.out - p.in) / 60000 : 0), 0);
    return `<div class="panel"><h3>${esc(nom)} <span class="pill">${ps.length} pointage${ps.length > 1 ? 's' : ''} · ${dur(total)}</span></h3><table class="l"><tr><th>Date</th><th>Arrivée</th><th>Départ</th><th class="r">Durée</th><th></th></tr>
      ${ps.map(p => `<tr><td>${new Date(p.in).toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit' })}${p.corrige ? ' <span class="pill">corrigé</span>' : ''}</td>
        <td><input type="time" value="${t(p.in)}" onchange="A.ptSet('${p.id}','in',this.value)" style="width:120px"></td>
        <td>${p.out ? `<input type="time" value="${t(p.out)}" onchange="A.ptSet('${p.id}','out',this.value)" style="width:120px">` : `<span class="pill warn">présent</span> <button class="btn sm ghost" onclick="A.ptSet('${p.id}','out','maintenant')">Pointer le départ</button>`}</td>
        <td class="r num">${p.out ? dur((p.out - p.in) / 60000) : '—'}</td><td class="r"><button class="btn sm ghost" onclick="A.ptDel('${p.id}')">✕</button></td></tr>`).join('')}</table></div>`;
  }).join('') || '<p class="muted">Aucun pointage sur la période.</p>';
  return h;
}
function admEquipe() {
  if (!adm.users) return '<p>Chargement…</p>';
  return `<div class="row" style="margin-bottom:12px"><p class="muted grow">Chacun se connecte en <b>passant son badge</b> sur le lecteur, ou avec son code. <b>Serveur</b> : prend les commandes. <b>Caisse</b> : encaisse, sorties, rase. <b>Responsable</b> : tout, et autorise annulations, remises et offerts (code ou badge). <b>Cuisine</b> : uniquement l’écran cuisine (tablette en cuisine).</p><button class="btn" onclick="A.addUser()">+ Personne</button><button class="btn dark" onclick="A.saveUsers()">Enregistrer</button></div>
  <div class="panel"><table class="l"><tr><th>Nom</th><th style="width:170px">Rôle</th><th style="width:120px">Code</th><th style="width:250px">Badge</th><th style="width:70px">Actif</th></tr>
  ${adm.users.map((u, i) => `<tr class="${u.actif ? '' : 'x'}"><td><input value="${esc(u.nom)}" onchange="A.uset(${i},'nom',this.value)"></td>
    <td><select onchange="A.uset(${i},'role',this.value)">${Object.entries(ROLE).map(([k, n]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${n}</option>`).join('')}</select></td>
    <td><input inputmode="numeric" maxlength="6" value="${esc(u.pin)}" onchange="A.uset(${i},'pin',this.value)"></td>
    <td><div class="row" style="flex-wrap:nowrap">${u.badge ? `<span class="pill ok">✓ badge enregistré</span><button class="btn sm ghost" onclick="A.uset(${i},'badge','');A.rr()">Retirer</button>` : `<button class="btn sm" onclick="A.badge(${i})">Passer le badge…</button>`}</div></td>
    <td><input type="checkbox" style="width:26px;height:26px" ${u.actif ? 'checked' : ''} onchange="A.uset(${i},'actif',this.checked)"></td></tr>`).join('')}</table></div>
  <p class="muted">N’oubliez pas « Enregistrer » après avoir ajouté les badges.</p>`;
}
function cfgDraft() { if (!adm.cfg) adm.cfg = JSON.parse(JSON.stringify(S.etat.config)); return adm.cfg; }

// --- Éditeur de plan
function admSalles() {
  const c = cfgDraft();
  if (adm.si == null || !c.salles[adm.si]) adm.si = 0;
  const s = c.salles[adm.si];
  const t = adm.selT != null ? s.tables[adm.selT] : null;
  const d = adm.selD != null ? (s.deco || [])[adm.selD] : null;
  return `<div class="ed">
    <div class="ed-plan"><div class="tabs">${c.salles.map((x, i) => `<button class="tab ${i === adm.si ? 'on' : ''}" onclick="A.esal(${i})">${esc(x.nom)} <span class="n">${x.tables.length}</span></button>`).join('')}<button class="tab" onclick="A.addSalle()">+ Salle</button></div>
      ${planHtml(s, true)}</div>
    <div class="ed-side">
      <div class="row"><button class="btn dark grow" onclick="A.saveCfg()">Enregistrer les plans</button></div>
      <p class="muted" style="font-size:14px">Faites glisser les tables pour les placer. Touchez une table pour changer son numéro ou la supprimer.</p>
      ${t ? `<div class="panel"><h3>Table ${esc(t.n)}</h3><div class="field"><label>Numéro</label><input value="${esc(t.n)}" onchange="A.tnum(this.value)"></div>
        <div class="row"><button class="btn sm bad" onclick="A.tdel()">Supprimer la table</button><button class="btn sm ghost" onclick="A.desel()">OK</button></div></div>` : ''}
      ${d ? `<div class="panel"><h3>${DECO[d.type] || d.type}</h3><div class="row"><button class="btn sm bad" onclick="A.ddel()">Supprimer</button><button class="btn sm ghost" onclick="A.desel()">OK</button></div></div>` : ''}
      <div class="row"><button class="btn grow" onclick="A.tadd()">+ Table</button></div>
      <div class="field"><label>Ajouter un élément</label><select onchange="A.dadd(this.value)"><option value="">Choisir…</option>${Object.entries(DECO).map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select></div>
      <div class="field"><label>Nom de la salle</label><input value="${esc(s.nom)}" onchange="A.sset('nom',this.value)"></div>
      <div class="field"><label>Fond</label><select onchange="A.sset('fond',this.value)">${Object.entries(FONDS).map(([k, n]) => `<option value="${k}" ${s.fond === k ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      <div class="field"><label>Taille des tables : ${s.taille}</label><input type="range" min="4" max="12" step="0.5" value="${s.taille}" onchange="A.sset('taille',+this.value)"></div>
      <div class="field"><label>Forme de la salle (largeur / hauteur) : ${(+s.ratio).toFixed(2)}</label><input type="range" min="0.8" max="2.6" step="0.05" value="${s.ratio}" onchange="A.sset('ratio',+this.value)"></div>
      <label class="chk"><input type="checkbox" ${s.grille ? 'checked' : ''} onchange="A.sset('grille',this.checked?[12,Math.round(12/${+s.ratio})]:null)"> Aligner sur un quadrillage</label>
      <div class="field"><label>Table de votre consommation (★, comptée à part dans la rase)</label><input value="${esc(c.tablePatron)}" onchange="adm.cfg.tablePatron=this.value"></div>
      ${c.salles.length > 1 ? `<button class="btn sm ghost" onclick="A.delSalle()">Supprimer cette salle</button>` : ''}
    </div></div>`;
}
// glisser-déposer des tables dans l'éditeur
let drag = null;
document.addEventListener('pointerdown', e => {
  if (S.view !== 'admin' || S.adminTab !== 'salles') return;
  const el = e.target.closest('.plan.edit [data-t], .plan.edit [data-d]');
  if (!el) return;
  const plan = el.closest('.plan');
  drag = { el, plan, rect: plan.getBoundingClientRect(), x0: e.clientX, y0: e.clientY, moved: false, t: el.dataset.t, d: el.dataset.d };
  S.dragging = true; el.setPointerCapture(e.pointerId); e.preventDefault();
});
document.addEventListener('pointermove', e => {
  if (!drag) return;
  if (Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) > 6) drag.moved = true;
  if (!drag.moved) return;
  const x = Math.max(0, Math.min(100, (e.clientX - drag.rect.left) / drag.rect.width * 100));
  const y = Math.max(0, Math.min(100, (e.clientY - drag.rect.top) / drag.rect.height * 100));
  drag.el.style.left = x + '%'; drag.el.style.top = y + '%'; drag.x = x; drag.y = y;
});
document.addEventListener('pointerup', () => {
  if (!drag) return;
  const D = drag; drag = null; S.dragging = false;
  const s = adm.cfg.salles[adm.si];
  if (D.t != null) {
    adm.selD = null;
    if (D.moved) { let x = D.x, y = D.y; if (s.grille) { const [c, r] = s.grille; x = (Math.min(c - 1, Math.floor(x / 100 * c)) + .5) / c * 100; y = (Math.min(r - 1, Math.floor(y / 100 * r)) + .5) / r * 100; } else { x = Math.round(x * 2) / 2; y = Math.round(y * 2) / 2; } Object.assign(s.tables[+D.t], { x: +x.toFixed(2), y: +y.toFixed(2) }); }
    adm.selT = +D.t;
  } else {
    adm.selT = null;
    if (D.moved) Object.assign(s.deco[+D.d], { x: Math.round(D.x * 2) / 2, y: Math.round(D.y * 2) / 2 });
    adm.selD = +D.d;
  }
  render();
});

function admImpr() {
  const c = cfgDraft();
  return `<div class="row" style="margin-bottom:12px"><p class="muted grow">Pour une imprimante en câble réseau, indiquez son adresse IP (page de test : maintenez FEED en l’allumant), port 9100. Pour une imprimante branchée en USB sur le PC de caisse, choisissez « USB sur ce PC » puis son nom dans Windows. Sans adresse, les impressions sont simulées dans le dossier data. Le choix de l’imprimante de chaque groupe se fait dans « Carte et prix ».</p><button class="btn" onclick="A.addImpr()">+ Imprimante</button><button class="btn dark" onclick="A.saveCfg()">Enregistrer</button></div>
  <div class="cols">${Object.entries(c.imprimantes).map(([k, p]) => `<div class="panel"><h3>${k === 'ticket' ? 'Tickets clients (caisse)' : `<input value="${esc(p.nom)}" onchange="adm.cfg.imprimantes['${k}'].nom=this.value" class="hin">`}</h3>
    <div class="seg" style="margin-bottom:10px"><button class="${p.type !== 'usb' ? 'on' : ''}" onclick="A.itype('${k}','reseau')">Câble réseau (IP)</button><button class="${p.type === 'usb' ? 'on' : ''}" onclick="A.itype('${k}','usb')">USB sur ce PC</button></div>
    ${p.type === 'usb' ? `<div class="field"><label>Imprimante Windows</label>
      ${adm.winPrinters && adm.winPrinters.length ? `<div class="chips">${adm.winPrinters.map(n => `<button class="chip ${p.windows === n ? 'on' : ''}" onclick="A.iwin('${k}','${jsq(n)}')">${esc(n)}</button>`).join('')}</div>` : ''}
      <div class="row"><input class="grow" value="${esc(p.windows || '')}" placeholder="Nom de l’imprimante dans Windows" onchange="adm.cfg.imprimantes['${k}'].windows=this.value.trim()"><button class="btn sm" onclick="A.chercherImpr()">Chercher sur ce PC</button></div>
      <p class="muted" style="font-size:13px;margin:6px 0 0">L’imprimante doit être branchée en USB sur le PC de la caisse principale et installée dans Windows (c’est le cas si FrontCash imprimait dessus).</p></div>`
    : `<div class="row"><div class="field grow"><label>Adresse IP</label><input value="${esc(p.ip)}" placeholder="ex. 192.168.1.100" onchange="adm.cfg.imprimantes['${k}'].ip=this.value.trim()"></div>
    <div class="field" style="width:110px"><label>Port</label><input type="number" value="${p.port}" onchange="adm.cfg.imprimantes['${k}'].port=+this.value"></div></div>`}
    <div class="row"><button class="btn sm" onclick="A.testPrint('${k}')">Imprimer un test</button>${k === 'ticket' ? `<button class="btn sm" onclick="A.testPrint('ticket',true)">Tester le tiroir</button>` : `<span class="muted" style="font-size:13px">${S.etat.categories.filter(x => x.poste === k).map(x => esc(x.nom)).join(', ') || 'aucun groupe'}</span><button class="btn sm ghost" style="margin-left:auto" onclick="A.delImpr('${k}')">Supprimer</button>`}</div></div>`).join('')}</div>
  <div class="panel"><div class="row">
    <div class="field" style="width:240px"><label>Largeur du papier</label><select onchange="adm.cfg.largeur=+this.value"><option value="48" ${c.largeur == 48 ? 'selected' : ''}>80 mm (48 caractères)</option><option value="42" ${c.largeur == 42 ? 'selected' : ''}>80 mm (42 caractères)</option><option value="32" ${c.largeur == 32 ? 'selected' : ''}>58 mm (32 caractères)</option></select></div>
    <div class="field" style="width:240px"><label>Table de caractères</label><select onchange="adm.cfg.pageCode=+this.value"><option value="16" ${c.pageCode == 16 ? 'selected' : ''}>16 · Windows-1252 (Epson)</option><option value="19" ${c.pageCode == 19 ? 'selected' : ''}>19 · CP858</option><option value="2" ${c.pageCode == 2 ? 'selected' : ''}>2 · CP850</option></select></div></div>
    <label class="chk"><input type="checkbox" ${c.sansAccents ? 'checked' : ''} onchange="adm.cfg.sansAccents=this.checked"> Imprimer sans accents (si les accents sortent mal)</label>
    <label class="chk"><input type="checkbox" ${c.tiroirAuto ? 'checked' : ''} onchange="adm.cfg.tiroirAuto=this.checked"> Ouvrir le tiroir automatiquement à chaque encaissement en espèces</label></div>`;
}
function admReglages() {
  const c = cfgDraft();
  const f = (k, l, t) => `<div class="field"><label>${l}</label><input ${t ? 'type="' + t + '"' : ''} value="${esc(c[k])}" onchange="adm.cfg.${k}=${t === 'number' ? '+this.value' : 'this.value'}"></div>`;
  return `<div class="row" style="margin-bottom:12px"><span class="grow"></span><button class="btn dark" onclick="A.saveCfg()">Enregistrer</button></div>
  <div class="cols"><div class="panel"><h3>Ticket</h3>${f('nom', 'Nom')}${f('adresse', 'Adresse')}${f('tel', 'Téléphone')}${f('piedTicket', 'Message en bas du ticket')}</div>
  <div class="panel"><h3>Caisse</h3>${f('fondCaisse', 'Fond de caisse (reste dans le tiroir)', 'number')}${f('deconnexionServeurSec', 'Déconnexion automatique des serveurs (secondes, 0 = jamais)', 'number')}
    <div class="field"><label>Motifs de sortie de caisse (un par ligne)</label><textarea onchange="adm.cfg.motifsSortie=this.value.split('\\n').map(s=>s.trim()).filter(Boolean)">${esc(c.motifsSortie.join('\n'))}</textarea></div>
    <div class="field"><label>Motifs d’annulation (un par ligne)</label><textarea onchange="adm.cfg.motifsAnnulation=this.value.split('\\n').map(s=>s.trim()).filter(Boolean)">${esc(c.motifsAnnulation.join('\n'))}</textarea></div>
    <div class="field"><label>Sociétés clientes (sur facture, une par ligne)</label><textarea onchange="adm.cfg.societes=this.value.split('\\n').map(s=>s.trim()).filter(Boolean)">${esc(c.societes.join('\n'))}</textarea></div></div></div>
  <div class="cols"><div class="panel"><h3>Commentaires rapides des plats</h3><p class="muted">Proposés quand le serveur touche un plat (un par ligne).</p><textarea style="min-height:220px;width:100%" onchange="adm.cfg.commentaires=this.value.split('\n').map(s=>s.trim()).filter(Boolean)">${esc((c.commentaires || []).join('\n'))}</textarea></div>
  <div class="panel"><h3>Notes de commande</h3><p class="muted">Pour toute la table, imprimées en haut des bons (une par ligne).</p><textarea style="min-height:220px;width:100%" onchange="adm.cfg.commentairesCommande=this.value.split('\n').map(s=>s.trim()).filter(Boolean)">${esc((c.commentairesCommande || []).join('\n'))}</textarea></div></div>
  <div class="panel"><h3>Ticket de caisse</h3>
    <label class="chk"><input type="checkbox" ${c.logoTicket !== false ? 'checked' : ''} onchange="adm.cfg.logoTicket=this.checked"> Imprimer le logo de La Maison Blanche en haut du ticket</label>
    <div class="field"><label>Lien du QR code imprimé en bas du ticket et de l’addition (vide = pas de QR code)</label><input value="${esc(c.qrLien || '')}" onchange="adm.cfg.qrLien=this.value.trim()"></div>
    <div class="field"><label>Texte sous le QR code</label><input value="${esc(c.qrTexte || '')}" onchange="adm.cfg.qrTexte=this.value"></div>
    <button class="btn" onclick="A.testPrint('ticket')">Imprimer un ticket d’essai</button></div>
  <div class="panel"><h3>Application et mises à jour</h3>${admApp()}</div>
  <div class="panel"><h3>Sauvegarde</h3><p class="muted">Une copie est faite automatiquement chaque jour dans le dossier data/sauvegardes du PC de caisse (90 jours gardés). Vous pouvez aussi télécharger une copie complète à garder ailleurs (clé USB, Google Drive).</p><a class="btn" href="/export/sauvegarde.json?t=${S.token}">Télécharger une sauvegarde</a></div>`;
}
function admApp() {
  const M = adm.maj || {}, E = M.etat || {}, I = adm.info;
  const quand = ts => ts ? new Date(ts).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'jamais';
  return `<table class="l">
    <tr><td>Version de la caisse</td><td class="r"><b>${esc(M.version || S.etat.version || '')}</b></td></tr>
    ${M.app ? `<tr><td>Mises à jour automatiques</td><td class="r">${E.erreur ? '<span class="pill bad">pas de connexion internet</span>' : E.prete ? '<span class="pill warn">version ' + esc(E.prete) + ' prête</span>' : '<span class="pill ok">à jour</span>'} <span class="muted" style="font-size:13px">vérifié : ${quand(E.verifie)}</span></td></tr>
    ${E.prete ? `<tr><td colspan="2" class="muted">La nouvelle version s’installe toute seule quand aucune table n’est ouverte (la caisse redémarre en quelques secondes). ${E.notes ? '<br>Nouveautés : ' + esc(E.notes) : ''}</td></tr>` : ''}` : '<tr><td colspan="2" class="muted">Caisse ouverte hors de l’application Windows : pas de mises à jour automatiques.</td></tr>'}
    ${I ? `<tr><td>Ce PC</td><td class="r">${I.mode === 'principale' ? 'Caisse principale' : 'Écran de salle → ' + esc(I.adresse)}</td></tr>
    ${I.mode === 'principale' ? `<tr><td>Adresse à donner aux écrans de salle</td><td class="r"><b>${esc((I.ip || []).join(' ou '))}</b></td></tr>` : ''}` : ''}
  </table>
  <div class="row" style="margin-top:12px">
    ${M.app ? `<button class="btn" onclick="A.majVerif()">Vérifier les mises à jour</button>${E.prete ? `<button class="btn gold" onclick="A.majInstaller()">Installer maintenant</button>` : ''}` : ''}
    ${window.caisseApp ? `${I && I.mode === 'principale' ? '<button class="btn" onclick="caisseApp.dossier()">Ouvrir le dossier des données</button>' : ''}<button class="btn" onclick="caisseApp.reglages()">Réglages de ce PC</button><button class="btn ghost" onclick="caisseApp.journal()">Journal technique</button><button class="btn bad" onclick="A.quitterApp()">Quitter l’application</button>` : ''}
  </div>`;
}
function admJournal() {
  if (!adm.journal) return '<p>Chargement…</p>';
  return `<div class="panel"><h3>Journal des actions (500 dernières)</h3><table class="l"><tr><th>Date</th><th>Qui</th><th>Action</th><th>Détail</th></tr>
  ${adm.journal.map(j => `<tr><td style="white-space:nowrap">${new Date(j.ts).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td><td>${esc(j.user)}</td><td>${esc(j.action)}</td><td class="muted">${esc(j.detail)}</td></tr>`).join('')}</table></div>`;
}

// ------------------------------------------------------------ Fenêtres
function modal(html, wide) { const m = $('#modal'); m.innerHTML = `<div class="mbox ${wide ? 'wide' : ''}">${html}</div>`; m.hidden = false; }
function closeModal() { const m = $('#modal'); m.hidden = true; m.innerHTML = ''; window.__pinCb = null; window.__badgeCapture = null; }
$('#modal').addEventListener('pointerdown', e => { if (e.target.id === 'modal') closeModal(); });
const mh = t => `<div class="mh"><h2>${t}</h2><button class="x" onclick="A.close()">×</button></div>`;

function numpad(id, onchange) {
  window.__np = window.__np || {};
  window.__np[id] = onchange;
  return `<div class="npad">${[1, 2, 3, 4, 5, 6, 7, 8, 9, '00', 0, '⌫'].map(k => `<button onclick="A.np('${id}','${k}')">${k}</button>`).join('')}</div>`;
}
const npv = {};

// code OU badge du responsable
function askPin(titre, cb, qui) {
  let p = '';
  const draw = () => { modal(mh(titre) + `<p class="muted">${qui || 'Badge ou code du responsable'}</p><div class="amount">${'•'.repeat(p.length) || '&nbsp;'}</div>
    <div class="npad">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 'C', 0, 'OK'].map(k => `<button onclick="A.pinK('${k}')">${k}</button>`).join('')}</div>`); window.__pinCb = done; };
  const done = v => { window.__pinCb = null; cb(v); };
  A.pinK = k => { if (k === 'C') p = ''; else if (k === 'OK') { done(p); return; } else if (p.length < 6) p += k; draw(); };
  draw();
}

// ------------------------------------------------------------ Actions
const A = window.A = {
  pin(k) { if (k === 'C') pin = ''; else if (k === 'OK') return S.pointage ? pointer({ pin }) : login(); else if (pin.length < 6) pin += k; render(); },
  pinTouch(k) { A.pin(k); if (pin.length === 6 && !S.pointage) login(); },
  modePointage(on) { S.pointage = !!on; S.pointeMsg = null; pin = ''; render(); },
  logout() { if (S.draft.length && !confirm('Des articles ne sont pas envoyés. Sortir quand même ?')) return; logout(); },
  close: closeModal,
  async go(v) {
    if (S.view === 'commande' && S.draft.length && v !== 'commande') { if (!confirm('Des articles ne sont pas encore envoyés. Les abandonner ?')) return; }
    if (v !== 'commande') { S.draft = []; S.cmdId = null; S.search = ''; S.sel = null; S.qty = ''; }
    S.view = v;
    if (v === 'caisse') await loadCaisse();
    if (v === 'kds') await loadKds();
    if (v === 'admin') { adm = {}; A.atab(S.adminTab); return; }
    render();
  },
  salle(id) { S.salle = id; localStorage.setItem('mb_salle', id); render(); },
  ouvrir(t) {
    let n = 2;
    const draw = () => modal(mh('Table ' + esc(t)) + `<p class="muted">Nombre de couverts</p><div class="qty"><button onclick="A.cv(-1)">−</button><span>${n}</span><button onclick="A.cv(1)">+</button></div>
      <div class="chips" style="justify-content:center">${[1, 2, 3, 4, 5, 6, 8, 10].map(k => `<button class="chip ${k === n ? 'on' : ''}" onclick="A.cvs(${k})">${k}</button>`).join('')}</div>
      <div class="mf"><button class="btn" onclick="A.close()">Annuler</button><button class="btn dark" onclick="A.ok()">Ouvrir la table</button></div>`);
    A.cv = d => { n = Math.max(1, Math.min(99, n + d)); draw(); };
    A.cvs = k => { n = k; draw(); };
    A.ok = () => act(async () => { const c = await api('/api/commande/ouvrir', { salle: S.salle, table: t, couverts: n }); closeModal(); if (!S.etat.commandes.find(x => x.id === c.id)) S.etat.commandes.push(c); A.voir(c.id); });
    draw();
  },
  comptoir() { act(async () => { const c = await api('/api/commande/ouvrir', { salle: 'comptoir', table: 'Comptoir', couverts: 1 }); S.etat.commandes.push(c); S.salle = 'emporter'; A.voir(c.id); }); },
  voir(id) { S.cmdId = id; S.draft = []; S.search = ''; S.sel = null; S.qty = ''; S.view = 'commande'; render(); },
  cat(id) { S.cat = id; S.search = ''; render(); },
  search(v) { S.search = v; render(); const i = $('#srch'); if (i) { i.focus(); i.setSelectionRange(v.length, v.length); } },
  nq(k) { if (k === 'C') { S.qty = ''; S.sel = null; } else if (S.qty.length < 2) S.qty = (S.qty + k).replace(/^0+/, ''); render(); },
  add(pid) {
    const p = prod(pid);
    if (p.stock === 0) return toast(p.nom + ' est épuisé', true);
    const n = Math.max(1, +S.qty || 1); S.qty = '';
    const deja = S.draft.filter(d => d.pid === pid).reduce((s, d) => s + d.qte, 0);
    if (p.stock > 0 && deja + n > p.stock) return toast('Il ne reste que ' + p.stock + ' « ' + p.nom + ' »', true);
    const groupes = (p.options || []).map(id => (S.etat.options || []).find(g => g.id === id)).filter(Boolean);
    if (groupes.length) return A.choixOptions(p, n, groupes);
    const last = S.draft[S.draft.length - 1];
    if (last && last.pid === pid && !last.note && !(last.opts || []).length && last.suite == null) last.qte += n; else S.draft.push({ pid, qte: n, note: '', opts: [], suite: null });
    S.sel = { t: 'd', i: S.draft.length - 1 };
    render();
  },
  choixOptions(p, n, groupes) {
    const sel = {};
    const ok = () => groupes.every(g => !g.obligatoire || (sel[g.id] || []).length);
    const draw = () => modal(mh(esc(p.nom) + (n > 1 ? ' × ' + n : '')) + groupes.map(g => `<p class="muted" style="margin:10px 0 0">${esc(g.nom)}${g.obligatoire ? ' <b style="color:var(--bad)">*</b>' : ''}${g.multiple ? ' (plusieurs possibles)' : ''}</p>
      <div class="chips">${g.choix.map((ch, i) => `<button class="chip big ${(sel[g.id] || []).includes(i) ? 'on' : ''}" onclick="A.och('${g.id}',${i})">${esc(ch.nom)}${ch.prix ? ' <small>+' + fmt(ch.prix) + '</small>' : ''}</button>`).join('')}</div>`).join('') +
      `<div class="mf"><button class="btn" onclick="A.close()">Annuler</button><button class="btn dark big" ${ok() ? '' : 'disabled'} onclick="A.ook()">Ajouter</button></div>`);
    A.och = (gid, i) => { const g = groupes.find(x => x.id === gid); const a = sel[gid] || []; if (g.multiple) { const j = a.indexOf(i); if (j >= 0) a.splice(j, 1); else a.push(i); sel[gid] = a; } else sel[gid] = a[0] === i && !g.obligatoire ? [] : [i]; if (!g.multiple && groupes.length === 1 && ok()) return A.ook(); draw(); };
    A.ook = () => { const opts = []; for (const g of groupes) for (const i of sel[g.id] || []) opts.push({ g: g.id, i }); S.draft.push({ pid: p.id, qte: n, note: '', opts, suite: null }); S.sel = { t: 'd', i: S.draft.length - 1 }; closeModal(); render(); };
    draw();
  },
  suite() {
    if (!S.sel || S.sel.t !== 'd') return toast('Touchez d’abord un article pas encore envoyé, puis « Suite » pour choisir quand il part (Direct, Entrées, Plats, Desserts).', true, 5000);
    const d = S.draft[S.sel.i]; d.suite = (suiteDraft(d) + 1) % 4; render();
  },
  async reclamer() {
    const c = cmd(); const r = await act(() => api('/api/commande/reclamer', { id: c.id }));
    if (r) { showErrs(r); if (!r.erreurs.length) toast('Réclame envoyée : ' + r.suite + ' ✓'); refresh(); }
  },
  message() {
    const c = cmd(); let texte = '', poste = 'tous';
    const rapides = ['Presser la table', 'Client pressé', 'Allergie, voir le serveur', 'Retirer la sauce', 'Envoyer les desserts', 'Annuler la suite'];
    const draw = () => modal(mh('Message · Table ' + esc(c.table)) + `<div class="chips">${[['tous', 'Tous'], ...postes()].map(([k, p]) => `<button class="chip ${poste === k ? 'on' : ''}" onclick="A.mp('${k}')">${esc(k === 'tous' ? 'Tous les postes' : p.nom)}</button>`).join('')}</div>
      <div class="chips">${rapides.map(m => `<button class="chip" onclick="A.mt('${jsq(m)}')">${m}</button>`).join('')}</div>
      <div class="field"><input id="msg" value="${esc(texte)}" placeholder="Votre message…" oninput="A.mtx(this.value)"></div>
      <div class="mf"><button class="btn" onclick="A.close()">Annuler</button><button class="btn dark" onclick="A.mgo()">Envoyer</button></div>`);
    A.mp = k => { poste = k; draw(); }; A.mt = m => { texte = m; draw(); }; A.mtx = v => { texte = v; };
    A.mgo = () => act(async () => { const r = await api('/api/commande/message', { id: c.id, poste, texte }); closeModal(); showErrs(r); if (!r.erreurs.length) toast('Message envoyé ✓'); });
    draw();
  },
  servi() { const c = cmd(); act(async () => { await api('/api/commande/servi', { id: c.id }); refresh(); }); },
  ruptures(poste) { rupturesModal(poste); },
  stk(pid, v) { act(async () => { if (v !== null && (v === '' || isNaN(+v))) return toast('Tapez une quantité', true); const r = await api('/api/produit/stock', { pid, stock: v === null ? null : +v }); const p = prod(pid); p.stock = r.stock; toast(p.nom + ' : ' + (r.stock === null ? 'disponible' : r.stock === 0 ? 'épuisé' : 'reste ' + r.stock)); rupturesModal(S._rupPoste); }); },
  kPoste(k) { S.kdsPoste = k; localStorage.setItem('mb_kds', k); render(); },
  kPret(id) { act(async () => { await api('/api/kds/pret', { id }); await loadKds(); render(); }); },
  kRappel(id) { act(async () => { await api('/api/kds/rappel', { id }); await loadKds(); render(); }); },
  async rapportX() { const r = await act(() => api('/api/rapport-x', {})); if (r) { showErrs(r); if (!r.erreurs.length) toast('Rapport X imprimé ✓'); } },
  selD(i) { if (S.sel && S.sel.t === 'd' && S.sel.i === i) return A.editDraft(i); S.sel = { t: 'd', i }; render(); },
  selS(id) { const l = cmd().lignes.find(x => x.id === id); if (S.sel && S.sel.t === 's' && S.sel.id === id && l && !l.annule && !l.paye) return A.ligneEnvoyee(id); S.sel = { t: 's', id }; render(); },
  note() {
    if (S.sel && S.sel.t === 'd') return A.editDraft(S.sel.i);
    if (S.sel && S.sel.t === 's') return toast('La note se met avant d’envoyer : cet article est déjà parti en cuisine.', true);
    if (S.draft.length) return A.editDraft(S.draft.length - 1);
    toast('Touchez d’abord un article de la commande.', true);
  },
  annuler() {
    if (S.sel && S.sel.t === 'd') { const d = S.draft[S.sel.i]; const n = +S.qty || d.qte; S.qty = ''; if (n >= d.qte) S.draft.splice(S.sel.i, 1); else d.qte -= n; S.sel = null; return render(); }
    if (S.sel && S.sel.t === 's') { const l = cmd().lignes.find(x => x.id === S.sel.id); if (l && !l.annule && !l.paye && Date.now() - l.envoye > 0) return A.annLigne(S.sel.id); }
    if (S.sel && S.sel.t === 's') return A.annLigne(S.sel.id);
    toast('Touchez d’abord la ligne à annuler.', true);
  },
  editDraft(i) {
    const d = S.draft[i], p = prod(d.pid);
    const notes = ['Saignant', 'À point', 'Bien cuit', 'Sans sauce', 'Sauce à part', 'Sans oignon', 'Sans gluten', 'Allergie', 'Peu épicé', 'Sans glaçons', 'À emporter', 'En même temps', 'Après les entrées'];
    const draw = () => modal(mh(esc(p.nom)) + `<div class="qty"><button onclick="A.dq(-1)">−</button><span>${d.qte}</span><button onclick="A.dq(1)">+</button></div>
      <p class="muted">Remarque pour la cuisine / le comptoir</p><div class="chips">${notes.map(n => `<button class="chip ${d.note.split(', ').includes(n) ? 'on' : ''}" onclick="A.dn('${jsq(n)}')">${n}</button>`).join('')}</div>
      <div class="field"><input id="note" value="${esc(d.note)}" placeholder="Autre remarque…" oninput="A.dnt(this.value)"></div>
      <div class="mf"><button class="btn bad" onclick="A.drm()">Retirer</button><button class="btn dark" onclick="A.close();A.rr()">OK</button></div>`);
    A.dq = k => { d.qte = Math.max(1, d.qte + k); draw(); };
    A.dn = n => { const parts = d.note ? d.note.split(', ') : []; const j = parts.indexOf(n); if (j >= 0) parts.splice(j, 1); else parts.push(n); d.note = parts.join(', '); draw(); };
    A.dnt = v => { d.note = v; };
    A.drm = () => { S.draft.splice(i, 1); S.sel = null; closeModal(); render(); };
    draw();
  },
  rr() { render(); },
  async envoyer() {
    const c = cmd(); if (!c || !S.draft.length) return;
    const r = await act(() => api('/api/commande/envoyer', { id: c.id, lignes: S.draft.slice() }));
    if (!r) return;
    S.draft = []; S.sel = null; S.qty = ''; showErrs(r);
    if (!r.erreurs.length) toast('Commande envoyée ✓');
    if (S.etat.user.role === 'serveur') { S.view = 'tables'; S.cmdId = null; }
    refresh();
  },
  ligneEnvoyee(id) {
    const c = cmd(), l = c.lignes.find(x => x.id === id);
    if (!l || l.annule || l.paye) return;
    modal(mh(l.qte + ' × ' + esc(l.nom)) + `<p class="muted">Envoyé à ${hm(l.envoye)}${l.note ? ' · ' + esc(l.note) : ''}</p>
      <div class="mf" style="flex-direction:column"><button class="btn" onclick="A.offrir('${id}')">${l.offert ? 'Ne plus offrir' : 'Offrir cet article'}</button><button class="btn bad" onclick="A.annLigne('${id}')">Annuler cet article</button><button class="btn ghost" onclick="A.close()">Fermer</button></div>`);
  },
  offrir(id) { const c = cmd(); askPin('Offrir un article', p => act(async () => { await api('/api/commande/offrir-ligne', { id: c.id, ligne: id, pin: p }); closeModal(); toast('C’est noté'); refresh(); })); },
  annLigne(id) {
    const c = cmd(), l = c.lignes.find(x => x.id === id);
    if (!l || l.annule) return toast('Cet article est déjà annulé.', true);
    if (l.paye) return toast('Cet article est déjà payé.', true);
    let q = Math.min(l.qte, +S.qty || l.qte), motif = ''; S.qty = '';
    const draw = () => modal(mh('Annuler ' + esc(l.nom)) + (l.qte > 1 ? `<p class="muted">Combien ?</p><div class="qty"><button onclick="A.aq(-1)">−</button><span>${q}</span><button onclick="A.aq(1)">+</button></div>` : '') +
      `<p class="muted">Motif</p><div class="chips">${S.etat.config.motifsAnnulation.map(m => `<button class="chip ${m === motif ? 'on' : ''}" onclick="A.am('${jsq(m)}')">${esc(m)}</button>`).join('')}</div>
      <div class="mf"><button class="btn" onclick="A.close()">Retour</button><button class="btn bad" ${motif ? '' : 'disabled'} onclick="A.ago()">Continuer</button></div>`);
    A.aq = d => { q = Math.max(1, Math.min(l.qte, q + d)); draw(); };
    A.am = m => { motif = m; draw(); };
    A.ago = () => (peut('caissier') ? (f => f('')) : f => askPin('Annulation par un caissier', f, 'Badge ou code d’un caissier'))(p => act(async () => { const r = await api('/api/commande/annuler-ligne', { id: c.id, ligne: id, qte: q, motif, pin: p }); closeModal(); S.sel = null; showErrs(r); if (!r.erreurs.length) toast('Article annulé, bon d’annulation imprimé'); refresh(); }));
    draw();
  },
  async addition() { const c = cmd(); if (S.draft.length) return toast('Envoyez d’abord la commande.', true); const r = await act(() => api('/api/commande/addition', { id: c.id })); if (r) { showErrs(r); if (!r.erreurs.length) toast('Addition imprimée à la caisse ✓'); refresh(); } },
  plus() {
    modal(mh('Options de la table') + `<div class="mf" style="flex-direction:column">
      ${peut('caissier') ? `<button class="btn" onclick="A.chServeur()">Changer de serveur</button>` : ''}
      <button class="btn" onclick="A.rebons()">Réimprimer les bons</button>
      ${enAttente(cmd()).length ? '<button class="btn" onclick="A.toutEnvoyer()">Tout lancer maintenant (sans attendre)</button>' : ''}
      <button class="btn bad" onclick="A.fermerVide()">Fermer la table (vide)</button>
      <button class="btn ghost" onclick="A.close()">Fermer</button></div>`);
  },
  transfert() {
    const c = cmd(); let salle = c.salle === 'comptoir' ? S.etat.config.salles[0].id : c.salle;
    const draw = () => { const s = S.etat.config.salles.find(x => x.id === salle); modal(mh('Transférer vers…') + `<div class="chips">${S.etat.config.salles.map(x => `<button class="chip ${x.id === salle ? 'on' : ''}" onclick="A.ts('${x.id}')">${esc(x.nom)}</button>`).join('')}</div>
      <p class="muted">Les tables en noir sont occupées : si vous en choisissez une, les deux tables sont regroupées.</p>
      <div class="chips">${s.tables.map(t => { const occ = S.etat.commandes.find(k => k.salle === salle && k.table === t.n && k.id !== c.id); return `<button class="chip ${occ ? 'on' : ''}" onclick="A.tt('${jsq(t.n)}')">${esc(t.n)}</button>`; }).join('')}</div>`, true); };
    A.ts = id => { salle = id; draw(); };
    A.tt = t => act(async () => { const r = await api('/api/commande/modifier', { id: c.id, salle, table: t }); closeModal(); S.cmdId = r.id; S.salle = salle; toast('Table transférée ✓'); refresh(); });
    draw();
  },
  couverts() { const c = cmd(); let n = c.couverts; const draw = () => modal(mh('Couverts') + `<div class="qty"><button onclick="A.cv(-1)">−</button><span>${n}</span><button onclick="A.cv(1)">+</button></div><div class="mf"><button class="btn dark" onclick="A.ok()">OK</button></div>`); A.cv = d => { n = Math.max(1, n + d); draw(); }; A.ok = () => act(async () => { await api('/api/commande/modifier', { id: c.id, couverts: n }); closeModal(); refresh(); }); draw(); },
  chServeur() { const c = cmd(); modal(mh('Serveur de la table') + `<div class="chips">${S.etat.users.filter(u => u.actif).map(u => `<button class="chip ${u.id === c.serveurId ? 'on' : ''}" onclick="A.cs('${u.id}')">${esc(u.nom)}</button>`).join('')}</div>`); A.cs = id => act(async () => { await api('/api/commande/modifier', { id: c.id, serveurId: id }); closeModal(); refresh(); }); },
  async rebons() { const c = cmd(); const r = await act(() => api('/api/commande/reimprimer-bons', { id: c.id })); if (r) { closeModal(); showErrs(r); if (!r.erreurs.length) toast('Bons réimprimés ✓'); } },
  async toutEnvoyer() { const c = cmd(); closeModal(); while (enAttente(c).length) { const r = await act(() => api('/api/commande/reclamer', { id: c.id })); if (!r) break; showErrs(r); await refresh(); if (!cmd()) break; Object.assign(c, cmd()); } toast('Toutes les suites sont lancées ✓'); },
  fermerVide() { const c = cmd(); act(async () => { await api('/api/commande/fermer-vide', { id: c.id }); closeModal(); S.draft = []; S.view = 'tables'; S.cmdId = null; refresh(); }); },

  // Séparation : choisir les articles que ce client paie
  separer() {
    const c = cmd();
    if (S.draft.length) return toast('Envoyez d’abord la commande.', true);
    const ls = c.lignes.filter(l => !l.annule && !l.paye);
    const pick = {};
    const tot = () => ls.reduce((s, l) => s + (pick[l.id] || 0) * (l.offert ? 0 : l.prix), 0);
    const draw = () => modal(mh('Séparation de l’addition') + `<p class="muted">Touchez les articles que ce client paie (plusieurs fois s’il y en a plusieurs).</p>
      <table class="l sepa">${ls.map(l => `<tr><td><button class="btn sm" onclick="A.sp('${l.id}',-1)">−</button></td><td class="num" style="width:70px;text-align:center"><b>${pick[l.id] || 0}</b> / ${l.qte}</td><td onclick="A.sp('${l.id}',1)" style="cursor:pointer">${esc(l.nom)}</td><td class="r num">${l.offert ? 'offert' : fmt(l.prix)}</td><td><button class="btn sm" onclick="A.sp('${l.id}',1)">+</button></td></tr>`).join('')}</table>
      <div class="row" style="margin-top:8px"><button class="btn sm" onclick="A.spAll()">Tout</button><button class="btn sm ghost" onclick="A.spNone()">Rien</button><span class="grow"></span><b class="num" style="font-size:22px">${da(tot())}</b></div>
      <div class="mf"><button class="btn" onclick="A.close()">Retour</button>${['especes', 'cheque', 'tpe'].map(m => `<button class="btn ok" ${tot() > 0 ? '' : 'disabled'} onclick="A.spGo('${m}')">${MODES[m]}</button>`).join('')}</div>`, true);
    A.sp = (id, d) => { const l = ls.find(x => x.id === id); pick[id] = Math.max(0, Math.min(l.qte, (pick[id] || 0) + d)); draw(); };
    A.spAll = () => { ls.forEach(l => (pick[l.id] = l.qte)); draw(); };
    A.spNone = () => { ls.forEach(l => (pick[l.id] = 0)); draw(); };
    A.spGo = m => { const sel = ls.filter(l => pick[l.id] > 0).map(l => ({ id: l.id, qte: pick[l.id], nom: l.nom, prix: l.prix, offert: l.offert })); A.encaisser(m, sel); };
    draw();
  },

  encaisser(mode, partie, avecRemise) {
    const c = cmd();
    if (S.draft.length) return toast('Envoyez d’abord la commande (bouton Commande).', true);
    const lignes = partie || c.lignes.filter(l => !l.annule && !l.paye);
    const total = lignes.reduce((s, l) => s + (l.offert ? 0 : l.qte * l.prix), 0);
    const st = { mode: mode || 'especes', saisie: '', pays: [], societe: '', reference: '', remise: null, pin: '', imprimer: true, motif: '' };
    const net = () => st.mode === 'offert' ? 0 : total - (st.remise ? (st.remise.type === 'pct' ? Math.round(total * st.remise.valeur / 100) : Math.min(total, st.remise.valeur)) : 0);
    const paye = () => st.pays.reduce((s, p) => s + p.montant, 0);
    const reste = () => net() - paye();
    const courant = () => +st.saisie || Math.max(0, reste());
    // ce qui serait encaissé si on valide maintenant
    const projete = () => st.mode === 'offert' ? [] : reste() > 0 ? [...st.pays, { mode: st.mode, montant: courant(), societe: st.societe, reference: st.reference }] : st.pays;
    const okValider = () => { if (st.mode === 'offert') return true; const pr = projete(); const s = pr.reduce((a, p) => a + p.montant, 0); const esp = pr.filter(p => p.mode === 'especes').reduce((a, p) => a + p.montant, 0); return s >= net() && s - net() <= esp && !pr.some(p => p.mode === 'societe' && !p.societe); };
    const draw = () => {
      const n = net(), r = reste(), pr = projete(), somme = pr.reduce((a, p) => a + p.montant, 0), rendu = somme - n;
      const billets = [...new Set([Math.max(r, 0), Math.ceil(r / 500) * 500, Math.ceil(r / 1000) * 1000, Math.ceil(r / 2000) * 2000, Math.ceil(r / 5000) * 5000])].filter(x => x >= r && x > 0).slice(0, 4);
      const left = `${partie ? `<p class="pill" style="display:block;text-align:center;padding:6px">Paiement séparé : ${partie.reduce((s, l) => s + l.qte, 0)} article(s)</p>` : ''}
        <div class="muted" style="text-align:center">À payer${st.remise ? ' (total ' + da(total) + ', remise ' + (st.remise.type === 'pct' ? st.remise.valeur + ' %' : da(st.remise.valeur)) + ' <button class="btn sm ghost" onclick="A.er()">retirer</button>)' : ''}</div>
        <div class="amount num">${fmt(n)} <small>DA</small></div>
        ${st.pays.length ? `<table class="l">${st.pays.map((p, i) => `<tr><td>${MODES[p.mode]}${p.societe ? ' · ' + esc(p.societe) : ''}${p.reference ? ' · ' + esc(p.reference) : ''}</td><td class="r num">${da(p.montant)}</td><td class="r"><button class="btn sm ghost" onclick="A.erm(${i})">✕</button></td></tr>`).join('')}</table>` : ''}
        ${st.mode !== 'offert' ? `<div class="calc"><span>${r > 0 ? 'Reste à payer' : 'Payé'}</span><b class="num" style="color:${r > 0 ? 'var(--bad)' : 'var(--ok)'}">${da(Math.max(r, 0))}</b></div>
        ${rendu > 0 && okValider() ? `<div class="calc"><span>À rendre</span><b class="num" style="color:var(--ok)">${da(rendu)}</b></div>` : ''}
        <div class="row"><span class="muted">Partager :</span>${[2, 3, 4, 5].map(k => `<button class="chip" onclick="A.ediv(${k})">÷ ${k}</button>`).join('')}</div>` : ''}
        <div class="row" style="margin-top:10px">${st.mode !== 'offert' && !st.remise && !st.pays.length ? `<button class="btn sm" onclick="A.erem()">Remise…</button>` : ''}<label class="chk" style="margin-left:auto"><input type="checkbox" ${st.imprimer ? 'checked' : ''} onchange="A.ei(this.checked)"> Imprimer le ticket</label></div>`;
      const right = `<div class="pay">${Object.entries(MODES).filter(([k]) => k !== 'mixte').map(([k, v]) => `<button class="${st.mode === k ? 'on' : ''}" onclick="A.em('${k}')">${v}</button>`).join('')}</div>
        ${st.mode === 'offert' ? `<div class="field"><label>Motif</label><input value="${esc(st.motif)}" oninput="A.eo(this.value)" placeholder="ex. Influenceuse, geste commercial…"></div><p class="muted">Toute la note est offerte (code ou badge du responsable).</p>` : r <= 0 ? '<p class="muted" style="text-align:center;margin-top:30px">Tout est payé : validez.</p>' : `
        ${st.mode === 'cheque' ? `<div class="field"><label>N° du chèque / banque (facultatif)</label><input value="${esc(st.reference)}" oninput="A.ef(this.value)"></div>` : ''}
        ${st.mode === 'tpe' ? '<p class="muted" style="margin:4px 0">Faites passer la carte sur le terminal, puis validez quand c’est accepté.</p>' : ''}
        ${st.mode === 'societe' ? `<div class="field"><label>Société</label><input list="socs" value="${esc(st.societe)}" oninput="A.es(this.value)" placeholder="Nom de la société"><datalist id="socs">${S.etat.config.societes.map(s => `<option value="${esc(s)}">`).join('')}</datalist></div>
          <div class="chips">${S.etat.config.societes.map(s => `<button class="chip ${s === st.societe ? 'on' : ''}" onclick="A.es('${jsq(s)}',1)">${esc(s)}</button>`).join('')}</div>` : ''}
        <div class="calc"><span>${st.mode === 'especes' ? 'Reçu du client' : 'Montant'}</span><b class="num">${da(courant())}</b></div>
        ${st.mode === 'especes' ? `<div class="chips">${billets.map(b => `<button class="chip ${+st.saisie === b ? 'on' : ''}" onclick="A.eb(${b})">${b === r ? 'Compte juste' : da(b)}</button>`).join('')}</div>` : ''}
        ${numpad('pay', v => { st.saisie = v; draw(); })}
        <button class="btn" style="width:100%;margin-top:8px" onclick="A.eadd()">+ Ajouter ce paiement (payer le reste autrement)</button>`}`;
      modal(mh('Encaisser · ' + (c.salle === 'comptoir' ? 'Comptoir' : 'Table ' + esc(c.table))) +
        `<div class="enc"><div>${left}</div><div>${right}</div></div>
        <div class="mf"><button class="btn" onclick="A.close()">Retour</button><button class="btn ok big" onclick="A.ego()" ${okValider() ? '' : 'disabled'}>Valider${st.mode === 'offert' ? ' l’offert' : ''}</button></div>`, true);
      npv.pay = st.saisie;
    };
    A.em = m => { st.mode = m; st.saisie = ''; if (m === 'offert') st.pays = []; draw(); };
    A.eb = b => { st.saisie = String(b); draw(); };
    A.es = (v, re) => { st.societe = v; if (re) draw(); else { const b = $('.mf .ok'); if (b) b.disabled = !okValider(); } };
    A.ef = v => { st.reference = v; };
    A.eo = v => { st.motif = v; };
    A.ei = v => { st.imprimer = v; };
    A.er = () => { st.remise = null; st.pin = ''; draw(); };
    A.ediv = k => { st.saisie = String(Math.min(Math.max(reste(), 0), Math.ceil(net() / k))); draw(); };
    A.eadd = () => { const m = courant(); if (!(m > 0)) return; if (st.mode === 'societe' && !st.societe.trim()) return toast('Nom de la société', true); if (m > reste() && st.mode !== 'especes') return toast('Seules les espèces peuvent dépasser le reste', true); st.pays.push({ mode: st.mode, montant: m, societe: st.societe.trim(), reference: st.reference }); st.saisie = ''; st.reference = ''; draw(); };
    A.erm = i => { st.pays.splice(i, 1); draw(); };
    A.erem = () => {
      let type = 'pct', val = '';
      const dr = () => modal(mh('Remise') + `<div class="chips"><button class="chip ${type === 'pct' ? 'on' : ''}" onclick="A.rt('pct')">En %</button><button class="chip ${type === 'da' ? 'on' : ''}" onclick="A.rt('da')">En DA</button></div>
        ${type === 'pct' ? `<div class="chips">${[5, 10, 15, 20, 25, 50].map(p => `<button class="chip ${+val === p ? 'on' : ''}" onclick="A.rv(${p})">${p} %</button>`).join('')}</div>` : `<div class="amount num">${val ? da(val) : '—'}</div>${numpad('rem', v => { val = v; dr(); })}`}
        <div class="mf"><button class="btn" onclick="A.rback()">Retour</button><button class="btn dark" ${+val > 0 ? '' : 'disabled'} onclick="A.rok()">Appliquer</button></div>`);
      A.rt = t => { type = t; val = ''; npv.rem = ''; dr(); };
      A.rv = p => { val = String(p); dr(); };
      A.rback = draw;
      A.rok = () => askPin('Autoriser la remise', p => { st.pin = p; st.remise = { type, valeur: +val }; draw(); });
      npv.rem = ''; dr();
    };
    A.ego = async () => {
      const go = async () => {
        const paiements = st.mode === 'offert' ? [{ mode: 'offert', montant: 0 }] : projete();
        const r = await act(() => api('/api/commande/encaisser', { id: c.id, paiements, remise: st.remise, pin: st.pin, imprimer: st.imprimer, motif: st.motif, lignes: partie ? partie.map(l => ({ id: l.id, qte: l.qte })) : null }));
        if (!r) return;
        closeModal(); showErrs(r);
        const t = r.ticket;
        if (!r.erreurs.length) toast((t.rendu ? 'Encaissé ✓ — rendre ' + da(t.rendu) : 'Encaissé ✓') + (r.partiel ? ' · il reste des articles sur la table' : ''), false, 5000);
        S.sel = null; S.qty = '';
        if (!r.partiel) { S.draft = []; S.cmdId = null; S.view = c.salle === 'comptoir' ? 'caisse' : 'tables'; }
        if (S.view === 'caisse') await loadCaisse();
        refresh();
      };
      if (st.mode === 'offert' && !st.pin) askPin('Autoriser l’offert', p => { st.pin = p; go(); });
      else go();
    };
    npv.pay = ''; draw();
    if (avecRemise) A.erem();
  },
  np(id, k) {
    let v = npv[id] || '';
    if (k === '⌫') v = v.slice(0, -1); else if (v.length < 9) v = (v + k).replace(/^0+/, '');
    npv[id] = v; window.__np[id](v);
  },
  sortie() {
    const st = { montant: '', motif: '', detail: '' };
    const draw = () => modal(mh('Sortie de caisse') + `<div class="amount num">${st.montant ? da(st.montant) : '—'}</div>${numpad('sortie', v => { st.montant = v; draw(); })}
      <p class="muted">Motif</p><div class="chips">${S.etat.config.motifsSortie.map(m => `<button class="chip ${m === st.motif ? 'on' : ''}" onclick="A.sm('${jsq(m)}')">${esc(m)}</button>`).join('')}</div>
      <div class="field"><input value="${esc(st.detail)}" oninput="A.sd(this.value)" placeholder="Détail / justificatif (nom de l’influenceuse, fournisseur…)"></div>
      <div class="mf"><button class="btn" onclick="A.close()">Annuler</button><button class="btn dark" ${+st.montant > 0 && st.motif ? '' : 'disabled'} onclick="A.sok()">Enregistrer la sortie</button></div>`);
    A.sm = m => { st.motif = m; draw(); };
    A.sd = v => { st.detail = v; };
    A.sok = () => act(async () => { await api('/api/sortie', st); closeModal(); toast('Sortie enregistrée ✓'); await loadCaisse(); refresh(); });
    npv.sortie = ''; draw();
  },
  supSortie(id) { askPin('Supprimer la sortie', p => act(async () => { await api('/api/sortie/supprimer', { id, pin: p }); closeModal(); await loadCaisse(); refresh(); })); },
  async tiroir() { const r = await act(() => api('/api/tiroir', { motif: 'manuel' })); if (r) showErrs(r); },
  async dup(num) { const r = await act(() => api('/api/ticket/reimprimer', { num })); if (r) { showErrs(r); if (!r.erreurs.length) toast('Duplicata imprimé ✓'); } },
  annTicket(num) {
    let motif = '', rouvrir = true;
    const draw = () => modal(mh('Annuler le ticket n° ' + num) + `<div class="field"><label>Motif</label><input value="${esc(motif)}" oninput="A.tm(this.value)" placeholder="ex. erreur de mode de paiement"></div>
      <label class="chk"><input type="checkbox" ${rouvrir ? 'checked' : ''} onchange="A.tr(this.checked)"> Remettre les articles sur la table pour les réencaisser</label>
      <div class="mf"><button class="btn" onclick="A.close()">Retour</button><button class="btn bad" onclick="A.tgo()">Continuer</button></div>`);
    A.tm = v => { motif = v; }; A.tr = v => { rouvrir = v; };
    A.tgo = () => { if (!motif.trim()) return toast('Indiquez un motif', true); askPin('Autoriser l’annulation', p => act(async () => { await api('/api/ticket/annuler', { num, motif, rouvrir, pin: p }); closeModal(); toast('Ticket annulé'); await loadCaisse(); refresh(); })); };
    draw();
  },
  async reZ(id) { const r = await act(() => api('/api/rase/reimprimer', { jour: id })); if (r) { showErrs(r); if (!r.erreurs.length) toast('Rapport Z imprimé ✓'); } },
  rase() {
    const r = S.caisse.resume; if (!r) return;
    const st = { compte: '', completePar: '', commentaire: '', forcer: false };
    const draw = () => {
      const ec = st.compte === '' ? null : +st.compte - r.aRemettre;
      modal(mh('Rase de fin de journée') + `
      ${r.tablesOuvertes ? `<p class="pill bad" style="display:block;padding:10px;border-radius:10px">⚠ Il reste ${r.tablesOuvertes} table(s) ouverte(s) pour ${da(r.montantOuvert)}. Encaissez-les d’abord.</p>` : ''}
      <table class="l"><tr><td>Espèces encaissées</td><td class="r num">${da(r.especes)}</td></tr><tr><td>− Sorties de caisse</td><td class="r num">${da(r.totalSorties)}</td></tr>
      <tr><td><b>Espèces à retirer (le fond de ${da(r.fondCaisse)} reste dans le tiroir)</b></td><td class="r num"><b>${da(r.aRemettre)}</b></td></tr>
      ${r.cheque ? `<tr><td class="muted">Chèques à remettre avec la rase (non comptés dans les espèces)</td><td class="r num muted">${da(r.cheque)}</td></tr>` : ''}
      ${r.tpe ? `<tr><td class="muted">Carte TPE (à vérifier avec le ticket du terminal)</td><td class="r num muted">${da(r.tpe)}</td></tr>` : ''}</table>
      <p class="muted" style="margin-top:12px">Comptez l’argent retiré (sans le fond de caisse) et tapez le montant :</p>
      <div class="amount num">${st.compte !== '' ? da(st.compte) : '—'}</div>
      ${ec !== null ? `<p style="text-align:center"><span class="pill ${ec ? 'bad' : 'ok'}" style="font-size:16px;padding:6px 14px">${ec === 0 ? 'Aucun écart ✓' : 'Écart : ' + (ec > 0 ? '+' : '') + da(ec)}</span></p>` : ''}
      ${numpad('rase', v => { st.compte = v; draw(); })}
      ${ec ? `<div class="field" style="margin-top:12px"><label>Qui complète l’écart ?</label><div class="chips">${S.etat.users.filter(u => u.actif && u.role !== 'admin').map(u => `<button class="chip ${st.completePar === u.nom ? 'on' : ''}" onclick="A.rp('${jsq(u.nom)}')">${esc(u.nom)}</button>`).join('')}</div><input value="${esc(st.completePar)}" oninput="A.rpt(this.value)" placeholder="Prénom"></div>` : ''}
      <div class="field"><label>Commentaire (facultatif)</label><input value="${esc(st.commentaire)}" oninput="A.rc(this.value)"></div>
      <div class="mf"><button class="btn" onclick="A.close()">Annuler</button><button class="btn gold big" ${st.compte === '' ? 'disabled' : ''} onclick="A.rgo()">Clôturer la journée</button></div>`);
    };
    A.rp = v => { st.completePar = v; draw(); }; A.rpt = v => { st.completePar = v; }; A.rc = v => { st.commentaire = v; };
    A.rgo = () => {
      if (r.tablesOuvertes && !confirm('Des tables sont encore ouvertes : elles passeront sur la journée suivante. Clôturer quand même ?')) return;
      st.forcer = true;
      act(async () => {
        const res = await api('/api/rase', st);
        showErrs(res);
        const z = res.resume, rz = res.rase;
        const txt = `Rase La Maison Blanche – journée n° ${z.jour.n} du ${new Date(z.jour.ouvert).toLocaleDateString('fr-FR')}\nCA : ${da(z.ca)} (espèces ${da(z.especes)}, chèques ${da(z.cheque)}, TPE ${da(z.tpe)}, sur facture ${da(z.societe)})\nTickets : ${z.nbTickets} – couverts : ${z.couverts}\nTable ${S.etat.config.tablePatron} (patron) : ${da(z.patron)}\nRemises : ${da(z.remises)} – offerts : ${da(z.offert)} – annulations après envoi : ${da(z.totalAnnulations)}\nSorties : ${da(z.totalSorties)}${z.sorties.map(s => '\n  - ' + s.motif + (s.detail ? ' (' + s.detail + ')' : '') + ' : ' + da(s.montant)).join('')}\nEspèces attendues : ${da(rz.attendu)} – comptées : ${da(rz.compte)} – écart : ${da(rz.ecart)}${rz.completePar ? ' (complété par ' + rz.completePar + ')' : ''}\nCaissier : ${rz.par}`;
        modal(mh('Journée clôturée ✓') + `<p>Le rapport Z est imprimé. Voici le résumé à envoyer pour l’appli de gestion :</p><textarea class="copy" id="ztxt" readonly>${esc(txt)}</textarea>
          <div class="mf"><button class="btn" onclick="A.cp()">Copier</button><a class="btn ok" href="https://wa.me/?text=${encodeURIComponent(txt)}" target="_blank">Envoyer sur WhatsApp</a></div><div class="mf"><button class="btn ghost" onclick="A.close()">Fermer</button></div>`);
        A.cp = () => { const t = $('#ztxt'); t.select(); try { navigator.clipboard.writeText(t.value); } catch (e) { document.execCommand('copy'); } toast('Copié ✓'); };
        await loadCaisse(); refresh();
      });
    };
    npv.rase = ''; draw();
  },

  // ---------- gestion
  async atab(t) {
    S.adminTab = t; render();
    if (t === 'rapports') { const [du, au] = periode(S.periode); S.rapport = await act(() => api(`/api/rapport?du=${du}&au=${au}`)); }
    if (t === 'equipe' && !adm.users) adm.users = await act(() => api('/api/admin/users'));
    if (t === 'journal') adm.journal = await act(() => api('/api/journal'));
    if (t === 'reglages') { adm.maj = await api('/api/maj').catch(() => null); if (window.caisseApp) adm.info = await caisseApp.info().catch(() => null); }
    if (t === 'pointage') { const [du, au] = periode(S.periode); adm.pointages = await act(() => api(`/api/admin/pointages?du=${du}&au=${au}`)); }
    render();
  },
  periode(p) { S.periode = p; A.atab('rapports'); },
  perso(k, v, tab) { const [du, au] = periode(S.periode); S.du = du; S.au = au; S[k] = v; S.periode = 'perso'; A.atab(tab || 'rapports'); },
  cset(i, k, v) { adm.carte.categories[i][k] = v; },
  pset(i, k, v) { adm.carte.produits[i][k] = v; if (k === 'actif') render(); },
  addCat() { adm.carte.categories.push({ id: 'c' + Date.now(), nom: 'Nouveau groupe', poste: postes()[0][0], couleur: '#efe3cc', suite: 2 }); render(); },
  mvCat(i, d) { const a = adm.carte.categories, j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; render(); },
  addProd(cat) { adm.carte.produits.push({ id: 'p' + Date.now(), nom: 'Nouvel article', prix: 0, cat, actif: true, options: [], stock: null }); render(); },
  delProd(i) { if (confirm('Supprimer « ' + adm.carte.produits[i].nom + ' » ? (vous pouvez aussi juste le masquer)')) { adm.carte.produits.splice(i, 1); render(); } },
  addOpt() { adm.carte.options.push({ id: 'o' + Date.now(), nom: 'Accompagnement', obligatoire: false, multiple: false, choix: [{ nom: 'Frites', prix: 0 }] }); render(); },
  delOpt(i) { if (confirm('Supprimer ce groupe d’options ?')) { const id = adm.carte.options[i].id; adm.carte.options.splice(i, 1); adm.carte.produits.forEach(p => (p.options = (p.options || []).filter(x => x !== id))); render(); } },
  oset(i, k, v) { adm.carte.options[i][k] = v; },
  chset(g, c, k, v) { adm.carte.options[g].choix[c][k] = v; },
  addCh(g) { adm.carte.options[g].choix.push({ nom: 'Nouveau choix', prix: 0 }); render(); },
  delCh(g, c) { adm.carte.options[g].choix.splice(c, 1); render(); },
  popt(pi, gid) { const p = adm.carte.produits[pi]; p.options = p.options || []; const j = p.options.indexOf(gid); if (j >= 0) p.options.splice(j, 1); else p.options.push(gid); render(); },
  ptSet(id, k, v) {
    const p = adm.pointages.find(x => x.id === id); if (!p) return;
    const base = new Date(p.in); let ts;
    if (v === 'maintenant') ts = Date.now(); else { const [h, m] = v.split(':').map(Number); const d = new Date(base); d.setHours(h, m, 0, 0); ts = d.getTime(); if (k === 'out' && ts < p.in) ts += 864e5; }
    act(async () => { await api('/api/admin/pointage', { id, in: k === 'in' ? ts : p.in, out: k === 'out' ? ts : p.out }); adm.pointages = null; A.atab('pointage'); toast('Corrigé ✓'); });
  },
  ptDel(id) { if (confirm('Supprimer ce pointage ?')) act(async () => { await api('/api/admin/pointage', { id, supprimer: true }); adm.pointages = null; A.atab('pointage'); }); },
  ptAdd() {
    const st = { userId: '', date: ymd(new Date()), a: '09:00', d: '17:00' };
    modal(mh('Ajouter un pointage') + `<div class="field"><label>Personne</label><select onchange="A.pa('userId',this.value)"><option value="">Choisir…</option>${S.etat.users.filter(u => u.actif).map(u => `<option value="${u.id}">${esc(u.nom)}</option>`).join('')}</select></div>
      <div class="row"><div class="field"><label>Date</label><input type="date" value="${st.date}" onchange="A.pa('date',this.value)"></div><div class="field"><label>Arrivée</label><input type="time" value="${st.a}" onchange="A.pa('a',this.value)"></div><div class="field"><label>Départ</label><input type="time" value="${st.d}" onchange="A.pa('d',this.value)"></div></div>
      <div class="mf"><button class="btn" onclick="A.close()">Annuler</button><button class="btn dark" onclick="A.pgo()">Ajouter</button></div>`);
    A.pa = (k, v) => { st[k] = v; };
    A.pgo = () => { if (!st.userId) return toast('Choisissez la personne', true); const tin = new Date(st.date + 'T' + st.a).getTime(); let tout = st.d ? new Date(st.date + 'T' + st.d).getTime() : null; if (tout && tout < tin) tout += 864e5; act(async () => { await api('/api/admin/pointage', { nouveau: true, userId: st.userId, in: tin, out: tout }); closeModal(); adm.pointages = null; A.atab('pointage'); }); };
  },
  majVerif() { act(async () => { await api('/api/maj/verifier', {}); toast('Vérification en cours…'); setTimeout(() => A.atab('reglages'), 6000); }); },
  majInstaller() { if (confirm('Installer la nouvelle version maintenant ? La caisse redémarre en quelques secondes.')) act(async () => { await api('/api/maj/installer', {}); toast('Installation… la caisse redémarre'); }); },
  quitterApp() { if (confirm('Fermer la caisse sur ce PC ?')) caisseApp.quitter(); },
  saveCarte() { act(async () => { await api('/api/admin/carte', adm.carte); adm.carte = null; toast('Carte enregistrée ✓'); refresh(); }); },
  uset(i, k, v) { adm.users[i][k] = v; if (k === 'actif') render(); },
  addUser() { adm.users.push({ nom: '', role: 'serveur', pin: String(Math.floor(1000 + Math.random() * 9000)), badge: '', actif: true }); render(); },
  badge(i) {
    const u = adm.users[i];
    modal(mh('Badge de ' + esc(u.nom || 'la personne')) + `<div class="scanme">💳</div><p style="text-align:center;font-size:18px">Passez maintenant la carte sur le lecteur…</p>
      <div class="field"><label>Ou tapez le numéro du badge</label><input id="bman" placeholder="Numéro du badge"></div>
      <div class="mf"><button class="btn" onclick="A.close()">Annuler</button><button class="btn dark" onclick="A.bok($('#bman').value)">OK</button></div>`);
    A.bok = v => { v = String(v || '').trim(); if (v.length < 3) return toast('Badge non lu', true); const autre = adm.users.find((x, j) => j !== i && x.badge === v); if (autre) return toast('Ce badge est déjà à ' + autre.nom, true); u.badge = v; closeModal(); toast('Badge lu ✓ — pensez à Enregistrer'); render(); };
    window.__badgeCapture = A.bok;
  },
  saveUsers() { act(async () => { adm.users = await api('/api/admin/users', { users: adm.users }); toast('Équipe enregistrée ✓'); refresh(); }); },
  // éditeur de plan
  esal(i) { adm.si = i; adm.selT = adm.selD = null; render(); },
  sset(k, v) { adm.cfg.salles[adm.si][k] = v; render(); },
  tnum(v) { v = String(v).trim(); const s = adm.cfg.salles[adm.si]; if (!v) return; const dbl = adm.cfg.salles.some(x => x.tables.some((t, j) => t.n === v && !(x === s && j === adm.selT))); if (dbl) { toast('La table ' + v + ' existe déjà', true); return render(); } s.tables[adm.selT].n = v; render(); },
  tdel() { adm.cfg.salles[adm.si].tables.splice(adm.selT, 1); adm.selT = null; render(); },
  tadd() {
    const all = adm.cfg.salles.flatMap(x => x.tables.map(t => +t.n)).filter(n => !isNaN(n));
    const s = adm.cfg.salles[adm.si];
    const base = s.tables.map(t => +t.n).filter(n => !isNaN(n));
    let n = (base.length ? Math.max(...base) : Math.max(0, ...all)) + 1; while (all.includes(n)) n++;
    s.tables.push({ n: String(n), x: 50, y: 50 }); adm.selT = s.tables.length - 1; adm.selD = null; render(); toast('Table ' + n + ' ajoutée au milieu : faites-la glisser');
  },
  dadd(type) { if (!type) return; const s = adm.cfg.salles[adm.si]; s.deco = s.deco || []; s.deco.push({ type, x: 50, y: 50 }); adm.selD = s.deco.length - 1; adm.selT = null; render(); },
  ddel() { adm.cfg.salles[adm.si].deco.splice(adm.selD, 1); adm.selD = null; render(); },
  desel() { adm.selT = adm.selD = null; render(); },
  addSalle() { adm.cfg.salles.push({ id: 's' + Date.now(), nom: 'Nouvelle salle', fond: 'creme', ratio: 1.6, taille: 7, grille: null, tables: [], deco: [] }); adm.si = adm.cfg.salles.length - 1; adm.selT = adm.selD = null; render(); },
  delSalle() { if (adm.cfg.salles.length > 1 && confirm('Supprimer la salle « ' + adm.cfg.salles[adm.si].nom + ' » ?')) { adm.cfg.salles.splice(adm.si, 1); adm.si = 0; render(); } },
  itype(k, t) { adm.cfg.imprimantes[k].type = t; render(); if (t === 'usb' && !adm.winPrinters) A.chercherImpr(); },
  iwin(k, n) { adm.cfg.imprimantes[k].windows = n; render(); },
  chercherImpr() { act(async () => { toast('Recherche des imprimantes du PC…'); const r = await api('/api/admin/imprimantes-windows'); adm.winPrinters = r.liste; render(); if (!r.windows) toast('La recherche marche seulement sur le PC Windows de la caisse principale', true); else if (!r.liste.length) toast('Aucune imprimante installée dans Windows', true); }); },
  addImpr() { const k = 'imp' + Date.now().toString(36); adm.cfg.imprimantes[k] = { nom: 'Nouvelle imprimante', ip: '', port: 9100 }; render(); },
  delImpr(k) { if (S.etat.categories.some(x => x.poste === k)) return toast('Des groupes de la carte utilisent cette imprimante : changez-les d’abord dans « Carte et prix ».', true); if (confirm('Supprimer cette imprimante ?')) { delete adm.cfg.imprimantes[k]; render(); } },
  saveCfg() { act(async () => { await api('/api/admin/config', adm.cfg); const keep = { si: adm.si }; adm = keep; toast('Réglages enregistrés ✓'); await refresh(); }); },
  testPrint(poste, tiroir) { act(async () => { if (adm.cfg) await api('/api/admin/config', adm.cfg); const r = await api('/api/admin/test-impression', { poste, tiroir }); toast(r.ok ? (r.simule ? 'Pas d’adresse IP : test simulé (fichier dans data)' : 'Test envoyé ✓') : r.erreur, !r.ok, 6000); }); },
};

// ------------------------------------------------------------ Actions de la prise de commande (v4)
Object.assign(A, {
  univ(u) { S.univ = u; S.search = ''; render(); const c = $('#cat'); if (c) c.scrollTop = 0; },
  saut(id) { const e = document.getElementById('sec-' + id); if (e) e.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
  add(pid, long) {
    const p = prod(pid);
    if (p.stock === 0) return toast(p.nom + ' est épuisé', true);
    const deja = S.draft.filter(d => d.pid === pid).reduce((s, d) => s + d.qte, 0);
    if (p.stock > 0 && deja + 1 > p.stock) return toast('Il ne reste que ' + p.stock + ' « ' + p.nom + ' »', true);
    if (long || (p.options || []).length) return A.feuille(null, { pid, qte: 1, note: '', opts: [], suite: null, emporter: false }, !long);
    const j = S.draft.findIndex(d => d.pid === pid && !d.note && !(d.opts || []).length && d.suite == null && !d.emporter);
    if (j >= 0) S.draft[j].qte++; else S.draft.push({ pid, qte: 1, note: '', opts: [], suite: null, emporter: false });
    S.flash = j >= 0 ? j : S.draft.length - 1; clearTimeout(S._fl); S._fl = setTimeout(() => { S.flash = null; }, 400);
    render();
    const l = $('.tk-l'); if (l) { const e = l.querySelector('.tl.d.flash'); if (e) e.scrollIntoView({ block: 'nearest' }); }
  },
  dqte(i, k) { const d = S.draft[i]; if (!d) return; d.qte += k; if (d.qte <= 0) S.draft.splice(i, 1); render(); },
  // fiche d'un article : quantité, cuisson/options, commentaires, à emporter, suite
  feuille(i, nouveau, rapide) {
    const c = cmd();
    const d = nouveau ? { ...nouveau } : { ...S.draft[i], opts: [...(S.draft[i].opts || [])] };
    const p = prod(d.pid);
    const groupes = (p.options || []).map(id => (S.etat.options || []).find(g => g.id === id)).filter(Boolean);
    const coms = S.etat.config.commentaires || [];
    const sel = {}; for (const o of d.opts || []) (sel[o.g] = sel[o.g] || []).push(o.i);
    const parts = d.note ? d.note.split(', ') : [];
    let chips = parts.filter(x => coms.includes(x)), libre = parts.filter(x => !coms.includes(x)).join(', ');
    const ok = () => groupes.every(g => !g.obligatoire || (sel[g.id] || []).length);
    const prixU = () => (p.prix || 0) + groupes.reduce((s, g) => s + (sel[g.id] || []).reduce((a, k) => a + (+g.choix[k].prix || 0), 0), 0);
    const draw = () => modal(mh(esc(p.nom) + ` <small class="muted">${fmt(prixU())} DA</small>`) + `<div class="fe">
      <div class="fe-row"><span>Quantité</span><div class="qty sm"><button onclick="A.fq(-1)">−</button><span>${d.qte}</span><button onclick="A.fq(1)">+</button></div></div>
      ${groupes.map(g => `<div class="fe-g ${g.obligatoire && !(sel[g.id] || []).length ? 'req' : ''}"><div class="fe-l">${esc(g.nom)}${g.obligatoire ? ' <b>*</b>' : ''}${g.multiple ? ' <span class="muted">(plusieurs possibles)</span>' : ''}</div>
        <div class="chips">${g.choix.map((ch, k) => `<button class="chip big ${(sel[g.id] || []).includes(k) ? 'on' : ''}" onclick="A.fo('${g.id}',${k})">${esc(ch.nom)}${ch.prix ? ' <small>+' + fmt(ch.prix) + '</small>' : ''}</button>`).join('')}</div></div>`).join('')}
      <div class="fe-g"><div class="fe-l">Commentaire pour la cuisine</div>
        <div class="chips">${coms.map(x => `<button class="chip ${chips.includes(x) ? 'on' : ''}" onclick="A.fc('${jsq(x)}')">${esc(x)}</button>`).join('')}</div>
        <div class="row"><input id="fe-libre" class="fe-in grow" value="${esc(libre)}" placeholder="Autre commentaire…" oninput="A.fl(this.value)"><button class="btn sm ${S.kbOn ? 'dark' : ''}" onclick="S.kbOn=!S.kbOn;A.fdraw()">⌨</button></div>
        ${S.kbOn ? clavier('fe-libre') : ''}</div>
      ${c.salle !== 'emporter' ? `<div class="fe-row"><span>🥡 À emporter</span><button class="tog ${d.emporter ? 'on' : ''}" onclick="A.fe()">${d.emporter ? 'Oui' : 'Non'}</button></div>` : ''}
      <div class="fe-row"><span>Part en cuisine</span><div class="seg">${[0, 1, 2, 3].map(s => `<button class="${suiteDraft(d) === s ? 'on' : ''}" onclick="A.fs(${s})">${SUITE_NOM(s)}</button>`).join('')}</div></div>
      </div>
      <div class="mf">${nouveau ? '<button class="btn" onclick="A.close()">Annuler</button>' : '<button class="btn bad" onclick="A.fdel()">Retirer</button><button class="btn" onclick="A.fdup()">Dupliquer</button>'}<button class="btn dark big" ${ok() ? '' : 'disabled'} onclick="A.fok()">${nouveau ? 'Ajouter ' + fmt(prixU() * d.qte) + ' DA' : 'OK'}</button></div>`, true);
    A.fdraw = draw;
    A.fq = k => { d.qte = Math.max(1, d.qte + k); draw(); };
    A.fo = (gid, k) => {
      const g = groupes.find(x => x.id === gid), a = sel[gid] || [];
      if (g.multiple) { const j = a.indexOf(k); if (j >= 0) a.splice(j, 1); else a.push(k); sel[gid] = a; }
      else sel[gid] = a[0] === k && !g.obligatoire ? [] : [k];
      // cuisson choisie en un geste : l'article est ajouté tout de suite
      if (rapide && nouveau && groupes.length === 1 && !g.multiple && ok()) return A.fok();
      draw();
    };
    A.fc = x => { const j = chips.indexOf(x); if (j >= 0) chips.splice(j, 1); else chips.push(x); draw(); };
    A.fl = v => { libre = v; };
    A.fe = () => { d.emporter = !d.emporter; draw(); };
    A.fs = s => { d.suite = s === (catDe(p).suite || 0) ? null : s; draw(); };
    A.fdel = () => { S.draft.splice(i, 1); closeModal(); render(); };
    A.fdup = () => { A.fok(true); };
    A.fok = dup => {
      d.opts = []; for (const g of groupes) for (const k of sel[g.id] || []) d.opts.push({ g: g.id, i: k });
      d.note = [...chips, libre.trim()].filter(Boolean).join(', ');
      if (nouveau) S.draft.push(d); else { S.draft[i] = d; if (dup) S.draft.splice(i + 1, 0, { ...d, opts: [...d.opts] }); }
      closeModal(); render();
    };
    draw();
  },
  ligneEnvoyee(id) {
    const c = cmd(), l = c.lignes.find(x => x.id === id);
    if (!l) return;
    modal(mh(l.qte + ' × ' + esc(l.nom)) + `<p class="muted">Envoyé à ${hm(l.envoye)}${(l.opts || []).length ? ' · ' + l.opts.map(o => esc(o.nom)).join(', ') : ''}${l.note ? ' · ' + esc(l.note) : ''}</p>
      <div class="grille">
        <button class="gb" onclick="A.recommander('${id}')">↻<span>Recommander le même</span></button>
        ${!l.annule && !l.paye ? `<button class="gb" onclick="A.offrir('${id}')">🎁<span>${l.offert ? 'Ne plus offrir' : 'Offrir'}</span></button><button class="gb bad" onclick="A.annLigne('${id}')">✕<span>Annuler l’article</span></button>` : ''}
      </div><div class="mf"><button class="btn ghost" onclick="A.close()">Fermer</button></div>`);
  },
  recommander(id) {
    const l = cmd().lignes.find(x => x.id === id); if (!l) return;
    const p = prod(l.pid); const opts = (l.opts || []).map(o => { const g = (S.etat.options || []).find(x => x.id === o.g); return g ? { g: g.id, i: g.choix.findIndex(ch => ch.nom === o.nom) } : null; }).filter(o => o && o.i >= 0);
    S.draft.push({ pid: l.pid, qte: 1, note: l.note || '', opts, suite: l.suite === (catDe(p).suite || 0) ? null : l.suite, emporter: !!l.emporter });
    closeModal(); render(); toast('Ajouté : ' + l.nom + ' — appuyez sur Envoyer');
  },
  kb(id, k) {
    const i = document.getElementById(id); if (!i) return;
    let v = i.value;
    if (k === '⌫') v = v.slice(0, -1); else if (k === 'C') v = ''; else v += (!v || /[.!?]\s$/.test(v)) && k.length === 1 && /[a-zéèàçù]/.test(k) ? k.toUpperCase() : k;
    i.value = v; i.dispatchEvent(new Event('input'));
  },
  // note pour toute la commande (imprimée en haut des bons)
  noteCmd() {
    const c = cmd(); const coms = S.etat.config.commentairesCommande || [];
    const parts = c.note ? c.note.split(', ') : [];
    let chips = parts.filter(x => coms.includes(x)), libre = parts.filter(x => !coms.includes(x)).join(', ');
    const draw = () => modal(mh('Note pour toute la commande') + `<p class="muted">Elle s’imprime en haut des bons de cuisine et s’affiche sur l’écran cuisine.</p>
      <div class="chips">${coms.map(x => `<button class="chip big ${chips.includes(x) ? 'on' : ''}" onclick="A.nc('${jsq(x)}')">${esc(x)}</button>`).join('')}</div>
      <input id="nc-libre" class="fe-in" style="width:100%" value="${esc(libre)}" placeholder="Autre note…" oninput="A.nl(this.value)">${clavier('nc-libre')}
      <div class="mf"><button class="btn" onclick="A.close()">Annuler</button><button class="btn dark" onclick="A.nok()">Enregistrer</button></div>`, true);
    A.nc = x => { const j = chips.indexOf(x); if (j >= 0) chips.splice(j, 1); else chips.push(x); draw(); };
    A.nl = v => { libre = v; };
    A.nok = () => act(async () => { await api('/api/commande/modifier', { id: c.id, note: [...chips, libre.trim()].filter(Boolean).join(', ') }); closeModal(); refresh(); });
    draw();
  },
  menuCmd() {
    const c = cmd(); const caisse = peut('caissier');
    const b = (ic, t, fn, cls = '') => `<button class="gb ${cls}" onclick="A.close();${fn}">${ic}<span>${t}</span></button>`;
    modal(mh(esc(titreCmd(c))) + `<div class="grille">
      ${b('🧾', 'Addition', 'A.addition()')}${b('⇄', 'Transférer / regrouper', 'A.transfert()')}${b('👥', 'Couverts', 'A.couverts()')}
      ${b('✉', 'Message à la cuisine', 'A.message()')}${b('🖨', 'Réimprimer les bons', 'A.rebons()')}${enAttente(c).length ? b('⏩', 'Tout lancer maintenant', 'A.toutEnvoyer()') : ''}
      ${c.salle === 'emporter' ? b('🥡', 'Client et heure de retrait', 'A.infosEmporter()') : ''}
      ${caisse ? b('✂', 'Séparer l’addition', 'A.separer()') + b('％', 'Remise', 'A.encaisser(\'especes\',null,true)') + b('💳', 'Autres paiements', 'A.encaisser(\'tpe\')') + b('🧑‍🍳', 'Changer de serveur', 'A.chServeur()') + b('⛔', 'Ruptures', 'A.ruptures()') : ''}
      ${b('🗑', 'Fermer la table vide', 'A.fermerVide()', 'bad')}
    </div>`, true);
  },
  infosEmporter(c0) {
    const c = c0 === undefined ? cmd() : null;
    const st = { nom: c && c.client ? c.client.nom : '', tel: c && c.client ? c.client.tel : '', retrait: c ? c.retrait : null, champ: 'em-nom' };
    const heures = [0, 15, 20, 30, 45, 60];
    const draw = () => modal(mh(c ? 'Commande à emporter ' + esc(c.table) : 'Nouvelle commande à emporter') + `
      <div class="row"><div class="field grow"><label>Nom du client</label><input id="em-nom" value="${esc(st.nom)}" onfocus="A.emf('em-nom')" oninput="A.ems('nom',this.value)"></div>
      <div class="field grow"><label>Téléphone</label><input id="em-tel" inputmode="tel" value="${esc(st.tel)}" onfocus="A.emf('em-tel')" oninput="A.ems('tel',this.value)"></div></div>
      ${clavier(st.champ)}
      <p class="muted" style="margin:10px 0 0">Heure de retrait</p>
      <div class="chips">${heures.map(m => { const v = m ? Date.now() + m * 60000 : null; const on = m === 0 ? !st.retrait : st.retrait && Math.abs(st.retrait - v) < 60000; return `<button class="chip big ${on ? 'on' : ''}" onclick="A.emr(${m})">${m ? '+ ' + m + ' min (' + hm(v) + ')' : 'Dès que possible'}</button>`; }).join('')}
</div>
      <div class="mf"><button class="btn" onclick="A.close()">Annuler</button><button class="btn dark big" onclick="A.emok()">${c ? 'Enregistrer' : 'Commencer la commande'}</button></div>`, true);
    A.emf = id => { if (st.champ !== id) { st.champ = id; draw(); const i = document.getElementById(id); if (i) i.focus(); } };
    A.ems = (k, v) => { st[k] = v; };
    A.emr = m => { st.retrait = m ? Date.now() + m * 60000 : null; draw(); };
    A.emok = () => act(async () => {
      if (c) { await api('/api/commande/modifier', { id: c.id, client: { nom: st.nom, tel: st.tel }, retrait: st.retrait }); closeModal(); refresh(); return; }
      const n = await api('/api/commande/ouvrir', { salle: 'emporter', client: { nom: st.nom, tel: st.tel }, retrait: st.retrait });
      closeModal(); S.etat.commandes.push(n); S.salle = 'emporter'; A.voir(n.id);
    });
    draw();
  },
  nouvelEmporter() { A.infosEmporter(null); },
  // ---- encaissement rapide en espèces (le cas habituel)
  async payer() {
    let c = cmd();
    if (S.draft.length) {
      const r = await act(() => api('/api/commande/envoyer', { id: c.id, lignes: S.draft.slice() }));
      if (!r) return; S.draft = []; showErrs(r); await refresh(); c = cmd(); if (!c) return;
    }
    const n = totalCmd(c);
    let recu = '';
    const ticket = () => localStorage.getItem('mb_ticket') !== '0';
    const billets = () => { const s = new Set(); for (const m of [500, 1000, 2000, 5000, 10000]) { const v = Math.ceil(n / m) * m; if (v > n) s.add(v); } [1000, 2000, 5000, 10000].forEach(v => { if (v > n) s.add(v); }); return [...s].sort((a, b) => a - b).slice(0, 5); };
    const draw = () => {
      const r = +recu || 0, rendu = r - n;
      modal(mh('Encaisser · ' + esc(titreCmd(c))) + `<div class="cash">
        <div><div class="cl">À payer</div><div class="cbig num">${fmt(n)} <small>DA</small></div>
          <button class="cexact" onclick="A.cgo(${n})">Compte juste · ${fmt(n)} DA</button>
          <div class="cl" style="margin-top:12px">Le client donne :</div>
          <div class="cbil">${billets().map(b => `<button class="${r === b ? 'on' : ''}" onclick="A.cb(${b})">${fmt(b)}</button>`).join('')}</div>
          <div class="crow"><span>Reçu</span><b class="num">${r ? da(r) : '—'}</b></div>
          <div class="crow rendu ${r && rendu < 0 ? 'bad' : ''}"><span>${r && rendu < 0 ? 'Il manque' : 'À rendre'}</span><b class="num">${r ? da(Math.abs(rendu)) : '—'}</b></div>
        </div>
        <div>${numpad('cash', v => { recu = v; draw(); })}
          <button class="btn ok big" style="width:100%;margin-top:10px" ${r >= n ? '' : 'disabled'} onclick="A.cgo(${r})">Valider ${r > n ? '· rendre ' + da(rendu) : ''}</button></div>
      </div>
      <div class="cother"><span class="muted">Autre paiement :</span>
        <button class="chip" onclick="A.encaisser('tpe')">Carte TPE</button><button class="chip" onclick="A.encaisser('cheque')">Chèque</button><button class="chip" onclick="A.encaisser('societe')">Facture société</button><button class="chip" onclick="A.encaisser('offert')">Offert</button><button class="chip" onclick="A.encaisser('especes')">Partager / plusieurs paiements</button><button class="chip" onclick="A.encaisser('especes',null,true)">Remise</button><button class="chip" onclick="A.separer()">Séparer par articles</button>
        <label class="chk" style="margin-left:auto"><input type="checkbox" ${ticket() ? 'checked' : ''} onchange="localStorage.setItem('mb_ticket',this.checked?'1':'0')"> Ticket</label></div>`, true);
      npv.cash = recu;
    };
    A.cb = b => { recu = String(b); draw(); };
    A.cgo = montant => act(async () => {
      const r = await api('/api/commande/encaisser', { id: c.id, paiements: [{ mode: 'especes', montant }], imprimer: ticket() });
      closeModal(); showErrs(r);
      const t = r.ticket;
      if (t.rendu > 0) modal(`<div class="rendu-big"><div>Rendre au client</div><b class="num">${da(t.rendu)}</b><button class="btn dark big" onclick="A.close()">OK</button></div>`);
      else toast('Encaissé ✓ ' + da(t.net), false, 3000);
      if (t.rendu > 0) setTimeout(() => { if ($('.rendu-big')) closeModal(); }, 8000);
      S.draft = []; S.cmdId = null; S.view = c.salle === 'comptoir' || c.salle === 'emporter' ? (peut('caissier') && c.salle === 'comptoir' ? 'caisse' : 'tables') : 'tables';
      if (S.view === 'caisse') await loadCaisse();
      refresh();
    });
    npv.cash = ''; draw();
  },
});

// ------------------------------------------------------------ Rendu
function render() {
  if (S.dragging) return;
  const app = $('#app');
  let h;
  if (!S.etat || S.view === 'login') h = viewLogin();
  else if (S.view === 'commande') h = viewCommande();
  else if (S.view === 'caisse') h = viewCaisse();
  else if (S.view === 'admin' && peut('admin')) h = viewAdmin();
  else if (S.view === 'kds' || S.etat.user.role === 'cuisine') { S.view = 'kds'; h = viewKds(); }
  else { S.view = 'tables'; h = viewTables(); }
  const sels = ['.main', '.fc-art', '.fc-lines', '.fc-grp', '.ed-side', '.kds'];
  const cle = S.view + '|' + S.adminTab + '|' + S.cmdId;
  const sc = S._scKey === cle ? sels.map(q => { const e = app.querySelector(q); return e ? e.scrollTop : 0; }) : [];
  const focusSearch = document.activeElement && document.activeElement.id === 'srch';
  app.innerHTML = h;
  S._scKey = cle;
  sels.forEach((q, i) => { const e = app.querySelector(q); if (e && sc[i]) e.scrollTop = sc[i]; });
  if (focusSearch) { const i = $('#srch'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
  const l = app.querySelector('.fc-lines'); if (l && S.view === 'commande' && S._lastDraft !== S.draft.length) { l.scrollTop = l.scrollHeight; S._lastDraft = S.draft.length; }
  fitPlans();
}
// clavier : code au clavier sur l'écran de connexion (le badge est géré à part)
document.addEventListener('keydown', e => {
  if (S.view === 'login' && !$('#modal').innerHTML) { if (/^\d$/.test(e.key)) A.pin(e.key); else if (e.key === 'Backspace') A.pin('C'); else if (e.key === 'Enter') A.pin('OK'); }
  else if (e.key === 'Escape') closeModal();
});

(async function start() {
  live();
  if (S.token) { try { S.etat = await api('/api/etat'); S.view = S.etat.user.role === 'cuisine' ? 'kds' : 'tables'; if (S.view === 'kds') await loadKds(); alertesPrets(); } catch (e) { S.token = ''; } }
  render();
  setInterval(() => { if ((S.view === 'tables' || S.view === 'kds') && !$('#modal').innerHTML) render(); }, 20000);
  setInterval(() => { if (S.view === 'kds') refresh(); }, 60000);
})();
