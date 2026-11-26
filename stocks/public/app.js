/* Gestion des stocks — La Maison Blanche. JavaScript natif, sans dépendance. */
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const NB = new Intl.NumberFormat('fr-FR', {minimumFractionDigits: 0, maximumFractionDigits: 2});
const NB3 = new Intl.NumberFormat('fr-FR', {maximumFractionDigits: 3});
const da = c => NB.format(Math.round(c || 0) / 100) + ' DA';
const qf = (m, u = '') => NB3.format((m || 0) / 1000) + (u ? ' ' + u : '');
const parseNum = s => { const v = Number(String(s ?? '').replace(/\s| /g, '').replace(',', '.')); return isFinite(v) ? v : NaN; };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/-/g, '');
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const fd = s => { if (!s) return ''; const [d, t] = String(s).split(' '); const [y, m, j] = d.split('-'); return `${j}/${m}/${y}` + (t ? ' ' + t.slice(0, 5) : ''); };
const SVC = {cuisine: 'Cuisine', asiatique: 'Asiatique', brunch: 'Brunch', comptoir: 'Comptoir / Bar'};
const KINDS = {sortie: 'Sortie vers service', retour_service: "Retour d'un service", perte: 'Perte / casse', retour_fournisseur: 'Retour fournisseur'};
const MVK = {reception: 'Réception', annulation_reception: 'Annulation réception', sortie: 'Sortie', retour_service: 'Retour service', perte: 'Perte', retour_fournisseur: 'Retour fournisseur', ajustement: 'Ajustement inventaire'};
const MODES = {especes: 'Espèces', cheque: 'Chèque', virement: 'Virement', autre: 'Autre'};
const RST = {brouillon: ['Brouillon', ''], soumise: ['À valider', 'warn'], a_corriger: ['À corriger', 'bad'], refusee: ['Refusée', 'bad'], approuvee: ['Approuvée — à payer', 'info'],
  partiellement_payee: ['Partiellement payée', 'gold'], payee: ['Payée', 'ok'], cloturee: ['Clôturée', ''], annulee: ['Annulée', 'bad'], soumis: ['À valider', 'warn'], approuve: ['Approuvé', 'ok'], rejete: ['Rejeté', 'bad']};
const rst = r => r.status === 'cloturee' && (r.review_comment || '').startsWith('Annulée') ? 'annulee' : r.status;
const tag = s => { const [l, c] = RST[s] || [s, '']; return `<span class="tag ${c}">${esc(l)}</span>`; };

const S = {token: localStorage.getItem('mb_stk') || sessionStorage.getItem('mb_stk') || '', session: null, ref: {suppliers: [], items: []}, page: 'tableau', online: true, params: {}};
const isDir = () => S.session?.user.role === 'direction';
const isMag = () => S.session?.user.role === 'magasinier';

/* ------------------------------------------------------------------ API */
class ApiError extends Error { constructor(m, st, body) { super(m); this.status = st; this.body = body || {}; } }
async function api(path, data, opt = {}) {
  const tries = data ? 4 : 2;
  for (let i = 0; ; i++) {
    let r;
    try {
      r = await fetch('/api/' + path, {method: data ? 'POST' : 'GET', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + S.token}, body: data ? JSON.stringify(data) : undefined, cache: 'no-store'});
    } catch (e) {
      setOnline(false);
      if (i + 1 < tries && !(data && OFFLINE_OK.includes(path))) { await new Promise(res => setTimeout(res, 1200 * (i + 1))); continue; }
      if (!data && !opt.raw) { const c = OQ.cacheGet(path); if (c !== undefined) return c; }
      if (data && OFFLINE_OK.includes(path) && !opt.noQueue) return OQ.add(path, data);
      throw new ApiError('Serveur injoignable : vérifiez le réseau puis réessayez (rien n\'a été enregistré en double).', 0);
    }
    setOnline(true);
    if (opt.raw && r.ok) return r;
    let body = {};
    try { body = opt.raw ? JSON.parse(await r.text()) : await r.json(); } catch (e) { }
    if (r.status === 401 && path !== 'connexion') { logout(true); throw new ApiError(body.erreur || 'Session expirée', 401); }
    if (r.status === 503 && i + 1 < tries) { await new Promise(res => setTimeout(res, 800)); continue; }
    if (!r.ok) {
      if (body.code === 'must_change') forcePassword();
      throw new ApiError(body.erreur || 'Erreur ' + r.status, r.status, body);
    }
    if (!data && !opt.raw) OQ.cacheSet(path, body);
    return body;
  }
}
/* ------------------------------------------------------------------ mode hors ligne (PC magasinier sans Wi-Fi)
   Réceptions et sorties/retours/pertes saisies sans réseau : gardées sur ce PC (localStorage) puis envoyées
   automatiquement au retour du réseau, dans l'ordre. Le client_uid empêche tout doublon. */
const OFFLINE_OK = ['reception', 'mouvement'];
const OQ = {
  K: 'mb_file_attente', R: 'mb_refusees', C: 'mb_cache:',
  list() { try { return JSON.parse(localStorage.getItem(this.K) || '[]'); } catch (e) { return []; } },
  refused() { try { return JSON.parse(localStorage.getItem(this.R) || '[]'); } catch (e) { return []; } },
  store(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  cacheGet(path) { try { const v = localStorage.getItem(this.C + path); return v ? JSON.parse(v) : undefined; } catch (e) { return undefined; } },
  cacheSet(path, body) { if (/^(session|referentiel|tableau|receptions|mouvements|demandes|factures|a-payer|inventaires)(\?|$)/.test(path)) this.store(this.C + path, body); },
  add(path, data) {
    const note = 'saisi hors ligne le ' + new Date().toLocaleString('fr-FR', {dateStyle: 'short', timeStyle: 'short'});
    const fld = path === 'reception' ? 'notes' : 'reason';
    data = Object.assign({}, data, {[fld]: ((data[fld] || '') + (data[fld] ? ' — ' : '') + note).slice(0, 300)});
    const q = this.list();
    q.push({path, data, saisi_le: new Date().toLocaleString('fr-FR'), par: S.session?.user.display_name || ''});
    if (!this.store(this.K, q)) throw new ApiError('Mémoire du PC pleine : impossible de garder la saisie hors ligne.', 0);
    if (path === 'mouvement') {  // stock affiché diminué / augmenté localement en attendant l'envoi
      const sign = data.kind === 'retour_service' ? 1 : -1;
      for (const l of data.lines || []) { const it = itemById(l.item_id); if (it) { const u = it.units.find(x => x.name === l.unit) || {factor: 1}; it.qty += sign * Math.round(parseNum(l.qty) * u.factor * 1000); } }
      this.cacheSet('referentiel', S.ref);
    }
    this.show(); return {hors_ligne: true};
  },
  sending: false,
  async flush() {
    if (this.sending || !S.token || !this.list().length) return;
    this.sending = true; let sent = 0;
    try {
      let q;
      while ((q = this.list()).length) {
        const it = q[0];
        try { await api(it.path, it.data, {noQueue: true}); sent++; }
        catch (e) {
          if (e.status === 0 || e.status === 401 || e.status === 503) break;  // toujours hors ligne ou reconnexion nécessaire : on garde
          const r = this.refused(); r.push(Object.assign(it, {erreur: e.message})); this.store(this.R, r);
        }
        this.store(this.K, this.list().slice(1));
      }
    } finally { this.sending = false; this.show(); }
    if (sent) { toast(`${sent} saisie(s) faite(s) hors ligne envoyée(s) au serveur`, 'ok'); try { await loadRef(); } catch (e) { } if (S.session && !$('#modals .back')) go(S.page, S.params); }
    if (this.refused().length) toast('Certaines saisies hors ligne ont été refusées : voir le bandeau orange', 'bad');
  },
  show() {
    let b = $('#queuebar'); if (!b) { b = document.createElement('div'); b.id = 'queuebar'; $('#main').prepend(b); }
    const n = this.list().length, r = this.refused().length;
    b.className = n || r ? '' : 'hidden';
    b.innerHTML = (n ? `${n} saisie(s) gardée(s) sur ce PC, envoi automatique dès le retour du Wi-Fi. ` : '') + (r ? `<b>${r} saisie(s) refusée(s) par le serveur.</b> ` : '') + `<button class="btn sm" id="qbSee">Voir</button>`;
    $('#qbSee').onclick = () => this.modal();
  },
  modal() {
    const lab = it => (it.path === 'reception' ? 'Réception' : KINDS[it.data.kind] || 'Mouvement') + ` — ${esc(it.saisi_le)}` + (it.data.lines ? ` — ${it.data.lines.length} article(s)` : '');
    const q = this.list(), r = this.refused();
    const m = modal({title: 'Saisies hors ligne', body: `<h3>En attente d'envoi (${q.length})</h3>${q.map(it => `<div>${lab(it)}</div>`).join('') || '<div class="muted">Aucune</div>'}
      <h3 style="margin-top:14px">Refusées par le serveur (${r.length})</h3>${r.map((it, i) => `<div class="alertbox bad">${lab(it)}<br>${esc(it.erreur)} <button class="btn sm" data-del="${i}">Retirer</button></div>`).join('') || '<div class="muted">Aucune</div>'}
      ${r.length ? '<div class="muted small">Ressaisissez une saisie refusée après correction (ex. stock insuffisant), puis retirez-la de la liste.</div>' : ''}`,
      foot: `<button class="btn dark" id="qSend">Envoyer maintenant</button>`});
    $$('[data-del]', m).forEach(b => b.onclick = () => { const x = this.refused(); x.splice(+b.dataset.del, 1); this.store(this.R, x); m.close(); this.show(); this.modal(); });
    $('#qSend', m).onclick = async () => { m.close(); await this.flush(); };
  },
};
window.addEventListener('online', () => OQ.flush());
setInterval(() => { if (OQ.list().length) OQ.flush(); }, 30000);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
/* Envoi d'une écriture : identifiant unique conservé pour les nouveaux essais (pas de doublon après une coupure). */
async function save(path, data, btn) {
  if (btn) btn.classList.add('busy');
  try { return await api(path, Object.assign({client_uid: uid()}, data)); }
  finally { if (btn) btn.classList.remove('busy'); }
}
function setOnline(v) {
  if (S.online === v) return; S.online = v;
  $('#offline').classList.toggle('hidden', v); $('#netstate').classList.toggle('off', !v);
  $('#netstate span').textContent = v ? 'Connecté' : 'Hors connexion';
  if (v) OQ.flush();
  if (v && S.session && !$('#modals .back')) go(S.page, S.params);  // retour du réseau : on recharge la page affichée
}
setInterval(async () => { if (!S.token) return; try { await fetch('/api/ping', {cache: 'no-store'}); setOnline(true); } catch (e) { setOnline(false); } }, 10000);

/* ------------------------------------------------------------------ interface commune */
function toast(msg, kind = '') { const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = msg; $('#toasts').append(t); setTimeout(() => t.remove(), kind === 'bad' ? 7000 : 3500); }
function modal({title, body, foot = '', size = '', onClose}) {
  const back = document.createElement('div'); back.className = 'back';
  back.innerHTML = `<div class="modal ${size}"><div class="mh"><h2>${title}</h2><button class="x" title="Fermer">×</button></div><div class="mb">${body}</div>${foot ? `<div class="mf"><span class="err"></span>${foot}</div>` : ''}</div>`;
  const close = () => { back.remove(); onClose && onClose(); };
  back.querySelector('.x').onclick = close;
  back.addEventListener('mousedown', e => { if (e.target === back) back.dataset.down = 1; });
  back.addEventListener('mouseup', e => { if (e.target === back && back.dataset.down) close(); back.dataset.down = ''; });
  $('#modals').append(back);
  const m = back.querySelector('.modal'); m.close = close; m.err = t => { const e = m.querySelector('.err'); if (e) e.textContent = t || ''; else if (t) toast(t, 'bad'); };
  setTimeout(() => { const f = m.querySelector('.mb input:not([type=checkbox]):not([readonly]),.mb select,.mb textarea'); f && f.focus(); }, 30);
  return m;
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') { const b = $$('#modals .back').pop(); b && b.querySelector('.x').click(); } });
function confirmBox(title, text, okLabel = 'Confirmer', cls = 'dark', withReason = false) {
  return new Promise(res => {
    const m = modal({title, body: `<p style="margin-top:0">${text}</p>` + (withReason ? `<label class="f">${withReason}<textarea id="cbReason"></textarea></label>` : ''),
      foot: `<button class="btn" data-a="no">Annuler</button><button class="btn ${cls}" data-a="ok">${okLabel}</button>`, onClose: () => res(null)});
    m.querySelector('[data-a=no]').onclick = () => m.close();
    m.querySelector('[data-a=ok]').onclick = () => {
      const r = withReason ? m.querySelector('#cbReason').value.trim() : true;
      if (withReason && !r) return m.err('Ce champ est obligatoire');
      res(r); m.querySelector('.x').onclick = null; $('#modals').lastChild.remove();
    };
  });
}
const opt = (v, l, sel) => `<option value="${esc(v)}"${String(v) === String(sel) ? ' selected' : ''}>${esc(l)}</option>`;
const supplierOptions = (sel, all = false) => `<option value="">— Choisir —</option>` + S.ref.suppliers.filter(s => all || s.active || s.id == sel).map(s => opt(s.id, s.name, sel)).join('');
const itemById = id => S.ref.items.find(i => i.id == id);
const supplierName = id => (S.ref.suppliers.find(s => s.id == id) || {}).name || '';
const empty = (t, s = '') => `<div class="empty"><div class="big">${t}</div>${s}</div>`;
async function loadRef() { S.ref = await api('referentiel'); renderDatalist(); }
function renderDatalist() {
  let dl = $('#dl-items'); if (!dl) { dl = document.createElement('datalist'); dl.id = 'dl-items'; document.body.append(dl); }
  dl.innerHTML = S.ref.items.filter(i => i.active).map(i => `<option value="${esc(i.name)}">${esc(i.category || '')}</option>`).join('');
}

/* Documents : aperçu, impression, PDF, CSV */
async function blobOf(path) { const r = await api(path, null, {raw: true}); return await r.blob(); }
async function showDoc(path, title) {
  try {
    const url = URL.createObjectURL(await blobOf('doc/' + path));
    const m = modal({title, size: 'w3', body: `<iframe class="docframe" src="${url}"></iframe>`,
      foot: `<button class="btn" data-a="print">Imprimer</button>` + (S.session.pdf ? `<button class="btn dark" data-a="pdf">Télécharger le PDF</button>` : ''), onClose: () => URL.revokeObjectURL(url)});
    m.querySelector('[data-a=print]').onclick = () => m.querySelector('iframe').contentWindow.print();
    const p = m.querySelector('[data-a=pdf]'); if (p) p.onclick = () => download('pdf/' + path, title.replace(/[^\w\- ]+/g, '').trim() + '.pdf', p);
  } catch (e) { toast(e.message, 'bad'); }
}
async function download(path, name, btn) {
  btn && btn.classList.add('busy');
  try { const b = await blobOf(path); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
  catch (e) { toast(e.message, 'bad'); } finally { btn && btn.classList.remove('busy'); }
}
async function openAttachment(id) {
  try { const b = await blobOf('justificatif/' + id); window.open(URL.createObjectURL(b), '_blank'); } catch (e) { toast(e.message, 'bad'); }
}
function attachBlock(list, ownerType, ownerId, canAdd = true, after) {
  const id = 'att' + Math.random().toString(36).slice(2, 8);
  setTimeout(() => {
    const box = document.getElementById(id); if (!box) return;
    box.querySelectorAll('[data-att]').forEach(b => b.onclick = () => openAttachment(b.dataset.att));
    const inp = box.querySelector('input[type=file]');
    if (inp) inp.onchange = async () => {
      for (const f of inp.files) {
        try { await uploadFile(f, ownerType, ownerId); toast('Justificatif ajouté', 'ok'); } catch (e) { toast(e.message, 'bad'); }
      }
      after && after();
    };
  });
  return `<div class="attach" id="${id}">${(list || []).map(a => `<button class="f" data-att="${a.id}">${a.mime === 'application/pdf' ? '📄' : '🖼'} ${esc(a.filename)} <span class="muted small">${Math.round(a.size / 1024)} Ko</span></button>`).join('') || '<span class="muted small">Aucun justificatif</span>'}
   ${canAdd ? `<label class="btn sm">＋ Photo / scan<input type="file" accept="image/*,application/pdf" capture="environment" multiple class="hidden"></label>` : ''}</div>`;
}
async function uploadFile(file, ownerType, ownerId) {
  let blob = file, name = file.name;
  if (file.type.startsWith('image/') && file.type !== 'image/png' || file.size > 2.5e6 && file.type.startsWith('image/')) blob = await shrinkImage(file), name = name.replace(/\.\w+$/, '') + '.jpg';
  if (blob.size > 12e6) throw new Error('Fichier trop lourd (12 Mo maximum)');
  const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
  return api('justificatif', {owner_type: ownerType, owner_id: ownerId, filename: name, data});
}
async function shrinkImage(file) {
  const img = await createImageBitmap(file); const k = Math.min(1, 2000 / Math.max(img.width, img.height));
  const cv = document.createElement('canvas'); cv.width = img.width * k; cv.height = img.height * k;
  cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
  return await new Promise(res => cv.toBlob(res, 'image/jpeg', .85));
}

/* ------------------------------------------------------------------ connexion */
$('#loginForm').onsubmit = async e => {
  e.preventDefault(); $('#lgErr').textContent = '';
  try {
    const r = await api('connexion', {username: $('#lgUser').value.trim(), password: $('#lgPass').value});
    S.token = r.token; localStorage.setItem('mb_stk', r.token); $('#lgPass').value = ''; await start();
  } catch (err) { $('#lgErr').textContent = err.message; }
};
if (location.hostname.endsWith('.ts.net')) $('#lgMag').remove();
else $('#lgMag').onclick = async () => {
  $('#lgErr').textContent = '';
  try { const r = await api('connexion', {magasinier_direct: true}); S.token = r.token; localStorage.setItem('mb_stk', r.token); await start(); }
  catch (err) { $('#lgErr').textContent = err.message; }
};
function logout(expired) {
  if (!expired && S.token) fetch('/api/deconnexion', {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + S.token}, body: '{}'}).catch(() => {});
  S.token = ''; S.session = null; sessionStorage.removeItem('mb_stk'); localStorage.removeItem('mb_stk');
  $('#shell').classList.add('hidden'); $('#login').classList.remove('hidden'); $('#modals').innerHTML = '';
  if (expired) $('#lgErr').textContent = 'Session terminée : reconnectez-vous.';
}
function forcePassword() { if (!$('#pwForced')) passwordModal(true); }
function passwordModal(forced) {
  const m = modal({title: forced ? 'Choisissez votre mot de passe' : 'Changer mon mot de passe', body: `<div id="${forced ? 'pwForced' : 'pwM'}" class="fields">
    ${forced ? '<div class="alertbox info">Votre mot de passe est provisoire : choisissez-en un personnel pour continuer.</div>' : ''}
    <label class="f">Mot de passe actuel<input type="password" id="pwOld" autocomplete="current-password"></label>
    <label class="f">Nouveau mot de passe (10 caractères minimum, lettres et chiffres)<input type="password" id="pwNew" autocomplete="new-password"></label>
    <label class="f">Confirmer<input type="password" id="pwNew2" autocomplete="new-password"></label></div>`,
    foot: `<button class="btn dark" id="pwOk">Enregistrer</button>`});
  $('#pwOk').onclick = async () => {
    if ($('#pwNew').value !== $('#pwNew2').value) return m.err('Les deux mots de passe sont différents');
    try { await api('mot-de-passe', {old: $('#pwOld').value, new: $('#pwNew').value}); m.close(); toast('Mot de passe modifié', 'ok'); S.session.user.must_change = 0; }
    catch (e) { m.err(e.message); }
  };
}

/* ------------------------------------------------------------------ navigation */
const NAV = [
  ['tableau', '◧', 'Tableau de bord'],
  ['#Magasin'],
  ['receptions', '⇩', 'Réceptions'], ['sorties', '⇧', 'Sorties & retours'], ['stock', '▦', 'Stock'], ['inventaires', '☑', 'Inventaires'],
  ['#Achats & paiements'],
  ['factures', '▤', 'Factures'], ['demandes', '◈', 'Demandes de paiement'], ['fournisseurs', '⌂', 'Fournisseurs'],
  ['#Analyse'],
  ['rapports', '◔', 'Rapports'],
  ['#Administration', 'dir'], ['comptes', '☺', 'Comptes', 'dir'], ['journal', '≡', 'Journal', 'dir'], ['sauvegardes', '⛁', 'Sauvegardes', 'dir'], ['reglages', '⚙', 'Réglages', 'dir'],
];
let badges = {};
function renderNav() {
  $('#nav').innerHTML = NAV.filter(n => !n[3] && n[1] !== 'dir' || isDir()).map(n => n[0][0] === '#' ? `<div class="sect">${n[0].slice(1)}</div>` :
    `<button data-p="${n[0]}" class="${S.page === n[0] ? 'on' : ''}"><span class="ic">${n[1]}</span>${n[2]}${badges[n[0]] ? `<span class="pill">${badges[n[0]]}</span>` : ''}</button>`).join('');
  $$('#nav button').forEach(b => b.onclick = () => { document.body.classList.remove('menu'); go(b.dataset.p); });
  const u = S.session.user;
  $('#me').innerHTML = `<b>${esc(u.display_name)}</b><span>${u.role === 'direction' ? 'Direction' : 'Magasinier'}</span><div class="row"><button id="mePw">Mot de passe</button><button id="meOut">Déconnexion</button></div>`;
  $('#mePw').onclick = () => passwordModal(false); $('#meOut').onclick = () => logout();
}
async function refreshBadges() {
  try {
    const t = await api('tableau'); const dm = Object.fromEntries(t.demandes.map(x => [x.status, x.n]));
    badges = isDir() ? {demandes: (dm.soumise || 0) + (dm.approuvee || 0) + (dm.partiellement_payee || 0) || '', inventaires: t.inventaires_a_valider || ''}
      : {demandes: dm.a_corriger || '', stock: t.alertes.length || ''};
    renderNav();
  } catch (e) { }
}
function setTitle(t, sub = '', actions = '') { $('#title').textContent = t; $('#subtitle').innerHTML = sub; $('#topActions').innerHTML = actions; document.title = t + ' — Stocks La Maison Blanche'; }
async function go(page, params = {}) {
  S.page = page; S.params = params; renderNav();
  const v = $('#view'); v.innerHTML = '<div class="empty">Chargement…</div>';
  try { await (PAGES[page] || PAGES.tableau)(v, params); }
  catch (e) { const n = NAV.find(x => x[0] === page); setTitle(n ? n[2] : '', '', ''); v.innerHTML = `<div class="alertbox bad">${esc(e.message)}</div>`; }
  $('#main').scrollTop = 0;
}
async function start() {
  S.session = await api('session');
  $('#login').classList.add('hidden'); $('#shell').classList.remove('hidden');
  await loadRef(); renderNav(); refreshBadges(); setInterval(refreshBadges, 60000);
  if (S.session.user.must_change) forcePassword();
  OQ.show(); OQ.flush();
  go('tableau');
}

/* ------------------------------------------------------------------ éditeur de lignes d'articles */
function lineEditor(host, mode, lines = [], onChange = () => {}) {
  // mode : reception (prix + remise), sortie (stock dispo), entree (retour service)
  const L = lines.length ? lines : [{}];
  const priced = mode === 'reception';
  function row(l, i) {
    const it = itemById(l.item_id);
    const units = it ? it.units : [];
    const unit = l.unit || (it ? (it.custom_units[0]?.name || it.base_unit) : '');
    const f = it ? (units.find(u => u.name === unit) || {factor: 1}).factor : 1;
    const q = parseNum(l.qty), base = isFinite(q) ? q * f : NaN;
    let hint = '';
    if (it) {
      if (unit !== it.base_unit && isFinite(base)) hint = `= ${NB3.format(base)} ${it.base_unit}`;
      if (mode === 'sortie') hint += `${hint ? ' · ' : ''}disponible : ${qf(it.qty, it.base_unit)}`;
      if (priced && it.avg_cost) hint += `${hint ? ' · ' : ''}dernier coût : ${da(it.last_cost * f)} / ${unit}`;
    }
    const pr = parseNum(l.unit_price), dsc = parseNum(l.discount_pct || 0);
    const tot = priced && isFinite(q) && isFinite(pr) ? q * pr * (1 - (isFinite(dsc) ? dsc : 0) / 100) : null;
    const over = mode === 'sortie' && it && isFinite(base) && base * 1000 > it.qty + 1e-6;
    return `<tr data-i="${i}"><td style="width:38%"><input list="dl-items" data-k="item" value="${esc(it ? it.name : l.itemText || '')}" placeholder="Rechercher un article…" class="${l.itemText && !it ? 'bad' : ''}">
      <div class="hint">${esc(hint)}</div>${priced && l.itemText && l.itemText.trim() && !it ? `<button class="btn sm" data-new style="margin-top:4px">＋ Créer l'article « ${esc(l.itemText.trim())} »</button>` : ''}</td>
      <td style="width:13%"><input data-k="qty" inputmode="decimal" value="${esc(l.qty ?? '')}" placeholder="Qté" class="${over ? 'bad' : ''}"></td>
      <td style="width:13%"><select data-k="unit">${units.map(u => opt(u.name, u.name + (u.factor !== 1 && !['g', 'mL', 'cL'].includes(u.name) ? ` (${NB3.format(u.factor)} ${it.base_unit})` : ''), unit)).join('')}</select></td>
      ${priced ? `<td style="width:14%"><input data-k="unit_price" inputmode="decimal" value="${esc(l.unit_price ?? '')}" placeholder="Prix DA / ${esc(unit || 'unité')}"></td>
      <td style="width:8%"><input data-k="discount_pct" inputmode="decimal" value="${esc(l.discount_pct ?? '')}" placeholder="%"></td>
      <td class="tot">${tot != null ? NB.format(Math.round(tot * 100) / 100) + ' DA' : '—'}</td>` : ''}
      <td style="width:34px"><button class="del" data-del title="Retirer la ligne">×</button></td></tr>`;
  }
  function render() {
    host.innerHTML = `<table class="lines"><thead><tr><th>Article</th><th>Quantité</th><th>Unité</th>${priced ? '<th>Prix unitaire</th><th>Remise</th><th class="r">Montant</th>' : ''}<th></th></tr></thead>
      <tbody>${L.map(row).join('')}</tbody></table>
      <div class="row" style="margin-top:8px"><button class="btn sm" data-add>＋ Ajouter un article</button><span class="muted small">Entrée sur la dernière case = nouvelle ligne</span>
      ${priced ? '' : ''}</div>` + (priced ? `<div class="totbar"><span class="muted">${L.filter(l => l.item_id).length} article(s)</span><span>Total du bon <span class="big" data-total></span></span></div>` : '');
    bind(); total();
  }
  function total() {
    if (!priced) return onChange(L);
    let t = 0; L.forEach(l => { const q = parseNum(l.qty), p = parseNum(l.unit_price), d = parseNum(l.discount_pct || 0); if (isFinite(q) && isFinite(p)) t += q * p * (1 - (isFinite(d) ? d : 0) / 100); });
    const el = host.querySelector('[data-total]'); if (el) el.textContent = NB.format(Math.round(t * 100) / 100) + ' DA';
    onChange(L, Math.round(t * 100));
  }
  function bind() {
    host.querySelectorAll('tr[data-i]').forEach(tr => {
      const l = L[tr.dataset.i];
      tr.querySelectorAll('[data-k]').forEach(inp => {
        const k = inp.dataset.k;
        inp.addEventListener(k === 'item' || k === 'unit' ? 'change' : 'input', () => {
          if (k === 'item') {
            const it = S.ref.items.find(x => x.active && x.name.toLowerCase() === inp.value.trim().toLowerCase());
            l.item_id = it ? it.id : null; l.itemText = inp.value; l.unit = null;
            if (it && priced && !l.unit_price && it.last_cost) { const u = it.custom_units[0]; l.unit_price = String(Math.round(it.last_cost * (u ? u.factor : 1)) / 100); }
            const pos = tr.dataset.i; render(); const nx = host.querySelector(`tr[data-i="${pos}"] [data-k=qty]`); nx && it && nx.focus();
          } else if (k === 'unit') { l.unit = inp.value; render(); }
          else { l[k] = inp.value; if (priced || mode === 'sortie') { const t = tr.querySelector('.tot'); const keep = document.activeElement; partial(tr, l); total(); keep && keep.focus(); } else total(); }
        });
        inp.addEventListener('keydown', e => {
          if (e.key === 'Enter') {
            e.preventDefault(); const all = [...tr.querySelectorAll('input,select')]; const idx = all.indexOf(inp);
            if (idx < all.length - 1) all[idx + 1].focus();
            else { L.push({}); render(); host.querySelector(`tr[data-i="${L.length - 1}"] [data-k=item]`).focus(); }
          }
        });
      });
      const nb = tr.querySelector('[data-new]');
      if (nb) nb.onclick = () => {
        if (S.online === false) return toast('Il faut le Wi-Fi pour créer un nouvel article', 'bad');
        itemForm(null, {name: l.itemText.trim(), onSaved: id => {
          const it = itemById(id); l.item_id = id; l.itemText = it ? it.name : l.itemText; l.unit = null; render();
          const nx = host.querySelector(`tr[data-i="${tr.dataset.i}"] [data-k=qty]`); nx && nx.focus();
        }});
      };
      tr.querySelector('[data-del]').onclick = () => { L.splice(tr.dataset.i, 1); if (!L.length) L.push({}); render(); };
    });
    host.querySelector('[data-add]').onclick = () => { L.push({}); render(); host.querySelector(`tr[data-i="${L.length - 1}"] [data-k=item]`).focus(); };
  }
  function partial(tr, l) {
    const tmp = document.createElement('tbody'); tmp.innerHTML = row(l, tr.dataset.i);
    const nt = tmp.querySelector('tr');
    const a = tr.querySelector('.tot'), b = nt.querySelector('.tot'); if (a && b) a.innerHTML = b.innerHTML;
    tr.querySelector('.hint').textContent = nt.querySelector('.hint').textContent;
    const q = tr.querySelector('[data-k=qty]'); q.className = nt.querySelector('[data-k=qty]').className;
  }
  render();
  return {
    lines: L,
    payload() {
      const out = [];
      for (const [i, l] of L.entries()) {
        if (!l.item_id && !l.itemText && !l.qty) continue;
        if (!l.item_id) throw new Error(`Ligne ${i + 1} : article inconnu « ${l.itemText || ''} » (créez-le dans Stock)`);
        if (!l.qty) throw new Error(`Ligne ${i + 1} : quantité manquante`);
        const it = itemById(l.item_id);
        const x = {item_id: l.item_id, qty: l.qty, unit: l.unit || it.custom_units[0]?.name || it.base_unit};
        if (priced) { if (l.unit_price === undefined || l.unit_price === '') throw new Error(`Ligne ${i + 1} : prix manquant`); x.unit_price = l.unit_price; x.discount_pct = l.discount_pct || 0; }
        out.push(x);
      }
      if (!out.length) throw new Error('Ajoutez au moins un article');
      return out;
    }
  };
}

/* ------------------------------------------------------------------ pages */
const PAGES = {};

PAGES.tableau = async v => {
  const t = await api('tableau');
  const w = t.semaine; const dm = Object.fromEntries(t.demandes.map(x => [x.status, x.n]));
  setTitle('Tableau de bord', `Semaine du ${fd(w.start)} au ${fd(w.end)}`);
  const maxc = Math.max(1, ...w.consommation.map(x => x.total));
  const colors = {cuisine: '#b8955a', asiatique: '#b3261e', brunch: '#2f7d4f', comptoir: '#1f3b5c'};
  const todo = [];
  let sante = '';
  if (isDir()) {
    try {
      const h = await api('sante');
      if (!h.ok) sante += `<div class="alertbox bad"><b>À vérifier sur le serveur :</b><br>${h.problemes.map(esc).join('<br>')}</div>`;
      if (h.mise_a_jour_refusee) sante += `<div class="alertbox warn">Une mise à jour défectueuse a été refusée automatiquement (${esc(h.mise_a_jour_refusee)}). Le logiciel continue avec la version précédente.</div>`;
    } catch (e) { }
    if (dm.soumise) todo.push(`<b>${dm.soumise}</b> demande(s) de paiement à valider`);
    if (dm.approuvee || dm.partiellement_payee) todo.push(`<b>${(dm.approuvee || 0) + (dm.partiellement_payee || 0)}</b> demande(s) approuvée(s) : paiements à confirmer`);
    if (t.inventaires_a_valider) todo.push(`<b>${t.inventaires_a_valider}</b> inventaire(s) à valider`);
  } else {
    if (dm.a_corriger) todo.push(`<b>${dm.a_corriger}</b> demande(s) renvoyée(s) pour correction`);
    if (dm.brouillon) todo.push(`<b>${dm.brouillon}</b> demande(s) en brouillon à soumettre`);
  }
  if (t.bons_sans_facture) todo.push(`<b>${t.bons_sans_facture}</b> bon(s) de livraison sans facture rapprochée`);
  if (t.factures_sans_bon) todo.push(`<b>${t.factures_sans_bon}</b> facture(s) sans bon de livraison rapproché`);
  v.innerHTML = sante + `
  ${isMag() ? `<div class="qa" style="margin-bottom:18px">
    <button data-go="receptions" data-new="1"><span>⇩</span><b>Nouvelle réception</b><small>Bon de livraison fournisseur</small></button>
    <button data-go="sorties" data-new="sortie"><span>⇧</span><b>Nouvelle sortie</b><small>Cuisine, asiatique, brunch, bar</small></button>
    <button data-go="factures" data-new="1"><span>▤</span><b>Enregistrer une facture</b><small>Et la rapprocher des bons</small></button>
    <button data-go="demandes" data-new="1"><span>◈</span><b>Demande de la semaine</b><small>Paiements fournisseurs</small></button></div>` : ''}
  <div class="grid g4">
    <div class="card kpi accent click" data-go="stock"><b>Valeur du stock</b><div class="v">${da(t.stock_value)}</div><div class="s">${t.nb_items} articles actifs</div></div>
    <div class="card kpi click" data-go="receptions"><b>Achats reçus (semaine)</b><div class="v">${da(w.achats)}</div><div class="s">bons validés</div></div>
    <div class="card kpi ${t.dette_totale ? 'alert' : 'good'} click" data-go="factures"><b>Dettes fournisseurs</b><div class="v">${da(t.dette_totale)}</div><div class="s">reste dû total</div></div>
    <div class="card kpi click" data-go="demandes"><b>Paiements (semaine)</b><div class="v">${da(w.paiements)}</div><div class="s">confirmés par la direction</div></div>
  </div>
  <div class="grid g2" style="margin-top:16px">
    <div class="card"><div class="hd"><h2>Consommation par service</h2><span class="muted small" style="margin-left:auto">valorisée au coût moyen · semaine</span></div><div class="bd"><div class="bars">
      ${w.consommation.map(x => `<div class="bar"><div class="lbl"><span><span class="svc svc-${x.service}"></span>${esc(x.label)}</span><b>${da(x.total)}</b></div><div class="tr"><div class="fl" style="width:${Math.max(0, x.total) / maxc * 100}%;background:${colors[x.service]}"></div></div></div>`).join('')}
      </div>${w.pertes ? `<p class="small muted" style="margin-bottom:0">Pertes et retours fournisseurs : <b>${da(w.pertes)}</b></p>` : ''}</div></div>
    <div class="card"><div class="hd"><h2>À faire</h2></div><div class="bd">${todo.length ? '<ul style="margin:0;padding-left:18px;line-height:1.9">' + todo.map(x => `<li>${x}</li>`).join('') + '</ul>' : '<div class="muted">Rien en attente.</div>'}</div></div>
  </div>
  <div class="card" style="margin-top:16px"><div class="hd"><h2>Alertes de stock</h2><span class="tag ${t.alertes.length ? 'bad' : 'ok'}" style="margin-left:auto">${t.alertes.length} sous le seuil</span></div>
    ${t.alertes.length ? `<table class="t"><thead><tr><th>Article</th><th class="r">Stock</th><th class="r">Seuil</th></tr></thead><tbody>${t.alertes.map(a => `<tr><td>${esc(a.name)}</td><td class="r"><b style="color:var(--bad)">${qf(a.qty, a.unit)}</b></td><td class="r">${qf(a.min_qty, a.unit)}</td></tr>`).join('')}</tbody></table>` : '<div class="bd muted">Aucun article sous son seuil d\'alerte.</div>'}</div>`;
  $$('[data-go]', v).forEach(b => b.onclick = () => go(b.dataset.go, b.dataset.new ? {nouveau: b.dataset.new} : {}));
};

/* ---------- Réceptions */
PAGES.receptions = async (v, p) => {
  setTitle('Réceptions', 'Bons de livraison : le stock augmente à la validation', isMag() ? `<button class="btn dark" id="newRec">＋ Nouvelle réception</button>` : '');
  if (isMag()) $('#newRec').onclick = () => receptionForm();
  const f = S.params.f || (S.params.f = {start: '', end: '', supplier: '', q: ''});
  const load = async () => {
    const qs = new URLSearchParams(Object.entries(f).filter(([, x]) => x)).toString();
    const list = await api('receptions?' + qs);
    $('#recList').innerHTML = list.length ? `<div class="tw"><table class="t"><thead><tr><th>Date</th><th>Fournisseur</th><th>N° bon</th><th>Facture</th><th>Saisi par</th><th class="r">Montant</th><th></th></tr></thead><tbody>
      ${list.map(r => `<tr class="click" data-id="${r.id}"><td>${fd(r.doc_date)}</td><td>${esc(r.supplier)}</td><td><b>${esc(r.number)}</b>${r.duplicate_reason ? ' <span class="tag warn" title="' + esc(r.duplicate_reason) + '">doublon justifié</span>' : ''}</td>
      <td>${r.status === 'annulee' ? '<span class="tag bad">Annulé</span>' : r.invoice ? `<span class="tag ok">${esc(r.invoice)}</span>` : '<span class="tag warn">sans facture</span>'}</td><td class="muted">${esc(r.who)}</td><td class="r"><b>${da(r.total)}</b></td><td class="r muted">›</td></tr>`).join('')}
      </tbody><tfoot><tr><td colspan="5">${list.length} bon(s)</td><td class="r">${da(list.filter(r => r.status === 'validee').reduce((a, r) => a + r.total, 0))}</td><td></td></tr></tfoot></table></div>` : empty('Aucun bon', 'Les réceptions validées apparaîtront ici.');
    $$('#recList tr[data-id]').forEach(tr => tr.onclick = () => receptionDetail(tr.dataset.id, load));
  };
  v.innerHTML = `<div class="toolbar"><div class="search"><input id="fq" placeholder="N° de bon ou fournisseur" value="${esc(f.q)}"></div>
    <select id="fs">${supplierOptions(f.supplier, true).replace('— Choisir —', 'Tous les fournisseurs')}</select>
    <label class="row small muted">Du <input type="date" id="fa" value="${f.start}"></label><label class="row small muted">au <input type="date" id="fb" value="${f.end}"></label>
    <span class="grow"></span><button class="btn sm" id="csv">Export CSV</button></div><div class="card" id="recList"></div>`;
  const upd = () => { f.q = $('#fq').value; f.supplier = $('#fs').value; f.start = $('#fa').value; f.end = $('#fb').value; load(); };
  ['#fs', '#fa', '#fb'].forEach(s => $(s).onchange = upd); let tm; $('#fq').oninput = () => { clearTimeout(tm); tm = setTimeout(upd, 300); };
  $('#csv').onclick = e => download(`export/receptions.csv?start=${f.start}&end=${f.end}`, 'receptions.csv', e.target);
  await load();
  if (p.nouveau && isMag()) receptionForm();
};

function receptionForm() {
  const m = modal({title: 'Nouvelle réception', size: 'w3', body: `
    <div class="fields c4"><label class="f span2">Fournisseur<div class="row" style="flex-wrap:nowrap"><select id="rSup">${supplierOptions('')}</select><button class="btn sm" id="rNewSup" title="Nouveau fournisseur">＋</button></div></label>
    <label class="f">N° du bon de livraison<input id="rNum" placeholder="ex. BL-2026-0153"></label><label class="f">Date du bon<input type="date" id="rDate" value="${today()}" max="${today()}"></label></div>
    <label class="row" style="gap:8px;margin-top:14px"><input type="checkbox" id="rDiv"> <span><b>Achat divers</b> — bon sans article de stock (matériel, pressing, prestations, petits achats…)</span></label>
    <h3 id="rLinesT" style="margin:18px 0 6px;font-size:17px">Articles reçus</h3><div id="rLines"></div><div id="rMisc" class="hidden"></div>
    <div class="fields c2" style="margin-top:14px"><label class="f">Notes<textarea id="rNotes" placeholder="Remarques sur la livraison (facultatif)"></textarea></label>
    <div class="col"><label class="row" style="gap:8px"><input type="checkbox" id="rInv"> <span>Ce bon vaut <b>facture</b> (enregistrer la facture en même temps)</span></label>
      <div id="rInvF" class="fields c2 hidden"><label class="f">N° de facture<input id="riNum" placeholder="même n° que le bon si vide"></label><label class="f">Échéance<input type="date" id="riDue"></label>
      <label class="f span2">Montant TTC de la facture (si différent du total du bon)<input id="riAmt" inputmode="decimal" placeholder="= total du bon"></label></div>
      <div class="muted small">Après validation, vous pourrez joindre la photo ou le scan du bon.</div></div></div>`,
    foot: `<button class="btn" data-a="cancel">Annuler</button><button class="btn dark lg" data-a="ok">Valider la réception</button>`});
  const ed = lineEditor($('#rLines', m), 'reception');
  const misc = miscEditor($('#rMisc', m));
  const isDiv = () => $('#rDiv', m).checked;
  const setDiv = on => {
    $('#rDiv', m).checked = on; $('#rLines', m).classList.toggle('hidden', on); $('#rMisc', m).classList.toggle('hidden', !on);
    $('#rLinesT', m).textContent = on ? 'Achats divers (hors stock)' : 'Articles reçus';
  };
  $('#rDiv', m).onchange = e => setDiv(e.target.checked);
  $('#rSup', m).addEventListener('change', e => { const s = (S.ref.suppliers || []).find(x => String(x.id) === e.target.value); if (s && /^divers/i.test(s.name)) setDiv(true); });
  $('#rInv', m).onchange = e => $('#rInvF', m).classList.toggle('hidden', !e.target.checked);
  $('#rNewSup', m).onclick = () => supplierForm(null, s => { $('#rSup', m).innerHTML = supplierOptions(s.id); });
  m.querySelector('[data-a=cancel]').onclick = () => m.close();
  const client_uid = uid();
  const send = async (btn, extra = {}) => {
    m.err('');
    let lines = [], misc_lines = [];
    try { if (isDiv()) misc_lines = misc.payload(); else lines = ed.payload(); } catch (e) { return m.err(e.message); }
    const body = {client_uid, supplier_id: $('#rSup', m).value, number: $('#rNum', m).value, doc_date: $('#rDate', m).value, notes: $('#rNotes', m).value, lines, ...extra};
    if (isDiv()) { body.divers = true; body.misc_lines = misc_lines; }
    if (!body.supplier_id) return m.err('Choisissez le fournisseur');
    if ($('#rInv', m).checked) body.invoice = {number: $('#riNum', m).value, due_date: $('#riDue', m).value, amount: $('#riAmt', m).value};
    btn.classList.add('busy');
    try {
      const r = await api('reception', body);
      if (r.hors_ligne) { m.close(); toast('Pas de Wi-Fi : réception gardée sur ce PC, elle sera envoyée automatiquement', 'ok'); return; }
      m.close(); toast(r.deja_enregistre ? 'Ce bon avait déjà été enregistré' : `Réception validée — ${da(r.total)}`, 'ok'); await loadRef();
      if (S.page === 'receptions') go('receptions'); receptionDetail(r.id, () => S.page === 'receptions' && go('receptions'));
    } catch (e) {
      if (e.body.code === 'doublon_probable') {
        const why = await confirmBox('Doublon probable', esc(e.message), 'Enregistrer quand même', 'bad', 'Pourquoi ce n\'est pas un doublon ?');
        if (why) return send(btn, {force: true, duplicate_reason: why});
      } else m.err(e.message);
    } finally { btn.classList.remove('busy'); }
  };
  m.querySelector('[data-a=ok]').onclick = e => send(e.currentTarget);
}

/* lignes libres d'un achat divers : désignation + montant */
function miscEditor(host) {
  const L = [{label: '', amount: ''}];
  function render() {
    host.innerHTML = `<table class="lines"><thead><tr><th>Désignation</th><th>Montant (DA)</th><th></th></tr></thead><tbody>
      ${L.map((l, i) => `<tr data-i="${i}"><td style="width:66%"><input data-k="label" value="${esc(l.label)}" placeholder="ex. sacs poubelle, réparation, pressing…"></td>
      <td><input data-k="amount" inputmode="decimal" value="${esc(l.amount)}" placeholder="Montant"></td><td style="width:34px"><button class="del" data-del title="Retirer la ligne">×</button></td></tr>`).join('')}</tbody></table>
      <div class="row" style="margin-top:8px"><button class="btn sm" data-add>＋ Ajouter une ligne</button></div>
      <div class="totbar"><span class="muted">${L.length} ligne(s)</span><span>Total du bon <span class="big" data-total></span></span></div>`;
    host.querySelectorAll('input').forEach(inp => inp.oninput = () => { L[+inp.closest('tr').dataset.i][inp.dataset.k] = inp.value; total(); });
    host.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { L.splice(+b.closest('tr').dataset.i, 1); if (!L.length) L.push({label: '', amount: ''}); render(); });
    host.querySelector('[data-add]').onclick = () => { L.push({label: '', amount: ''}); render(); host.querySelector(`tr[data-i="${L.length - 1}"] input`).focus(); };
    total();
  }
  function total() { const t = L.reduce((a, l) => a + (isFinite(parseNum(l.amount)) ? parseNum(l.amount) : 0), 0); host.querySelector('[data-total]').textContent = NB.format(Math.round(t * 100) / 100) + ' DA'; }
  render();
  return {
    payload() {
      const out = L.filter(l => l.label.trim() || String(l.amount).trim());
      if (!out.length) throw new Error('Ajoutez au moins une ligne (désignation et montant)');
      out.forEach((l, i) => {
        if (!l.label.trim()) throw new Error(`Ligne ${i + 1} : écrivez la désignation`);
        const a = parseNum(l.amount); if (!isFinite(a) || a <= 0) throw new Error(`Ligne ${i + 1} : montant invalide`);
      });
      return out.map(l => ({label: l.label.trim(), amount: parseNum(l.amount)}));
    }
  };
}

async function receptionDetail(id, after) {
  const r = await api('reception/' + id);
  const m = modal({title: `Bon ${esc(r.number)} — ${esc(r.supplier)}`, size: 'w2', body: `
    ${r.status === 'annulee' ? `<div class="alertbox bad">Bon annulé le ${fd(r.cancelled_at)} : ${esc(r.cancel_reason)}</div>` : ''}
    ${r.duplicate_reason ? `<div class="alertbox warn">Enregistré malgré un doublon probable : ${esc(r.duplicate_reason)}</div>` : ''}
    <dl class="kv"><dt>Date du bon</dt><dd>${fd(r.doc_date)}</dd><dt>Saisi par</dt><dd>${esc(r.who)} le ${fd(r.created_at)}</dd>
    <dt>Facture</dt><dd>${r.invoices.filter(i => i.status === 'active').map(i => `<span class="tag ok">${esc(i.number)} · ${da(i.amount)}</span>`).join(' ') || '<span class="tag warn">non rapproché</span>'}</dd>${r.notes ? `<dt>Notes</dt><dd>${esc(r.notes)}</dd>` : ''}</dl>
    ${r.misc_lines && r.misc_lines.length ? `<table class="t" style="margin-top:14px"><thead><tr><th>Désignation <span class="tag">achat divers · hors stock</span></th><th class="r">Montant</th></tr></thead><tbody>
    ${r.misc_lines.map(l => `<tr><td>${esc(l.label)}</td><td class="r">${da(l.amount)}</td></tr>`).join('')}</tbody><tfoot><tr><td>Total</td><td class="r">${da(r.total)}</td></tr></tfoot></table>` : ''}
    <table class="t ${r.misc_lines && r.misc_lines.length ? 'hidden' : ''}" style="margin-top:14px"><thead><tr><th>Article</th><th class="r">Quantité</th><th class="r">Prix unitaire</th><th class="r">Remise</th><th class="r">Montant</th></tr></thead><tbody>
    ${r.lines.map(l => `<tr><td>${esc(l.name)}</td><td class="r">${NB3.format(l.qty_entered)} ${esc(l.unit_name)}${l.unit_name !== l.base_unit ? `<div class="muted small">${qf(l.qty, l.base_unit)}</div>` : ''}</td><td class="r">${da(l.unit_price)}</td><td class="r">${l.discount_pct ? l.discount_pct + ' %' : ''}</td><td class="r">${da(l.total)}</td></tr>`).join('')}
    </tbody><tfoot><tr><td colspan="4">Total</td><td class="r">${da(r.total)}</td></tr></tfoot></table>
    <h3 style="margin:16px 0 8px;font-size:16px">Justificatifs</h3>${attachBlock(r.attachments, 'reception', r.id, r.status === 'validee', () => { m.close(); receptionDetail(id, after); })}`,
    foot: (r.status === 'validee' ? `<button class="btn bad" data-a="cancel">Annuler ce bon…</button>` : '') + `<button class="btn" data-a="doc">Imprimer / PDF</button>`});
  m.querySelector('[data-a=doc]').onclick = () => showDoc('reception/' + id, `Bon de réception ${r.number}`);
  const c = m.querySelector('[data-a=cancel]');
  if (c) c.onclick = async () => {
    const why = await confirmBox('Annuler le bon', 'Le stock sera diminué des quantités de ce bon (contre-écriture). Cette action est tracée.', 'Annuler le bon', 'bad', 'Motif de l\'annulation');
    if (!why) return;
    try { await save('reception/annuler', {receipt_id: id, reason: why}); toast('Bon annulé', 'ok'); m.close(); await loadRef(); after && after(); } catch (e) { toast(e.message, 'bad'); }
  };
}

/* ---------- Sorties */
PAGES.sorties = async (v, p) => {
  setTitle('Sorties & retours', 'Toute sortie du magasin est autorisée et enregistrée par le magasinier', isMag() ? `<button class="btn dark" id="newIss">＋ Nouveau mouvement</button>` : '');
  if (isMag()) $('#newIss').onclick = () => issueForm('sortie');
  const f = S.params.f || (S.params.f = {kind: '', service: '', start: '', end: ''});
  const load = async () => {
    const list = await api('mouvements?' + new URLSearchParams(Object.entries(f).filter(([, x]) => x)));
    $('#issList').innerHTML = list.length ? `<div class="tw"><table class="t"><thead><tr><th>Date</th><th>N°</th><th>Type</th><th>Destination</th><th>Articles</th><th>Demandeur</th><th class="r">Valeur</th></tr></thead><tbody>
      ${list.map(s => `<tr class="click" data-id="${s.id}"><td>${fd(s.created_at)}</td><td class="muted">S-${String(s.id).padStart(5, '0')}</td><td><span class="tag ${s.kind === 'sortie' ? '' : s.kind === 'retour_service' ? 'info' : 'warn'}">${KINDS[s.kind]}</span></td>
      <td>${s.service ? `<span class="svc svc-${s.service}"></span>${SVC[s.service]}` : esc(s.supplier || '—')}</td><td class="small">${s.lines.slice(0, 3).map(l => `${esc(l.name)} <span class="muted">${qf(Math.abs(l.qty), l.base_unit)}</span>`).join(' · ')}${s.lines.length > 3 ? ` <span class="muted">+${s.lines.length - 3}</span>` : ''}</td>
      <td class="muted">${esc(s.requested_by || '')}</td><td class="r"><b>${da(s.total)}</b></td></tr>`).join('')}</tbody></table></div>` : empty('Aucun mouvement', 'Les sorties vers les services apparaîtront ici.');
    $$('#issList tr[data-id]').forEach(tr => tr.onclick = () => showDoc('sortie/' + tr.dataset.id, 'Bon S-' + String(tr.dataset.id).padStart(5, '0')));
  };
  v.innerHTML = `<div class="toolbar"><div class="seg" id="fk">${[['', 'Tous'], ...Object.entries(KINDS)].map(([k, l]) => `<button data-k="${k}" class="${f.kind === k ? 'on' : ''}">${l.replace('Sortie vers service', 'Sorties')}</button>`).join('')}</div>
    <select id="fsv"><option value="">Tous les services</option>${Object.entries(SVC).map(([k, l]) => opt(k, l, f.service)).join('')}</select>
    <label class="row small muted">Du <input type="date" id="fa" value="${f.start}"></label><label class="row small muted">au <input type="date" id="fb" value="${f.end}"></label>
    <span class="grow"></span><button class="btn sm" id="csv">Export CSV des mouvements</button></div><div class="card" id="issList"></div>`;
  $$('#fk button').forEach(b => b.onclick = () => { f.kind = b.dataset.k; $$('#fk button').forEach(x => x.classList.toggle('on', x === b)); load(); });
  $('#fsv').onchange = e => { f.service = e.target.value; load(); }; $('#fa').onchange = e => { f.start = e.target.value; load(); }; $('#fb').onchange = e => { f.end = e.target.value; load(); };
  $('#csv').onclick = e => download(`export/mouvements.csv?start=${f.start}&end=${f.end}`, 'mouvements.csv', e.target);
  await load();
  if (p.nouveau && isMag()) issueForm(p.nouveau);
};

function issueForm(kind) {
  const m = modal({title: 'Nouveau mouvement de stock', size: 'w3', body: `
    <div class="seg" id="iKind" style="margin-bottom:14px">${Object.entries(KINDS).map(([k, l]) => `<button data-k="${k}" class="${k === kind ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="fields c3" id="iHead"></div><h3 style="margin:16px 0 6px;font-size:17px">Articles</h3><div id="iLines"></div>
    <div class="alertbox info small" style="margin-top:12px" id="iInfo"></div>`,
    foot: `<button class="btn" data-a="cancel">Annuler</button><button class="btn dark lg" data-a="ok">Autoriser et enregistrer</button>`});
  let ed;
  const head = () => {
    const svc = `<label class="f">Service<select id="iSvc"><option value="">— Choisir —</option>${Object.entries(SVC).map(([k, l]) => opt(k, l)).join('')}</select></label>`;
    $('#iHead', m).innerHTML = kind === 'sortie' ? svc + `<label class="f">Demandé par<input id="iReq" placeholder="ex. Chef de cuisine"></label><label class="f">Motif / commentaire<input id="iWhy" placeholder="facultatif"></label>`
      : kind === 'retour_service' ? svc + `<label class="f">Rapporté par<input id="iReq"></label><label class="f">Motif<input id="iWhy" placeholder="facultatif"></label>`
      : kind === 'perte' ? `<label class="f span2">Motif de la perte (obligatoire)<input id="iWhy" placeholder="ex. produit périmé, casse, rupture de la chaîne du froid"></label><label class="f">Constaté par<input id="iReq"></label>`
      : `<label class="f">Fournisseur<select id="iSup">${supplierOptions('')}</select></label><label class="f span2">Motif du retour (obligatoire)<input id="iWhy"></label>`;
    $('#iInfo', m).textContent = kind === 'retour_service' ? 'Le stock augmente : les articles reviennent au magasin, valorisés au coût moyen actuel.'
      : 'Le stock diminue immédiatement. Une sortie supérieure au stock disponible est refusée. Valeur calculée au coût moyen pondéré.';
    ed = lineEditor($('#iLines', m), kind === 'retour_service' ? 'entree' : 'sortie', ed ? ed.lines : []);
  };
  head();
  $$('#iKind button', m).forEach(b => b.onclick = () => { kind = b.dataset.k; $$('#iKind button', m).forEach(x => x.classList.toggle('on', x === b)); head(); });
  m.querySelector('[data-a=cancel]').onclick = () => m.close();
  const client_uid = uid();
  m.querySelector('[data-a=ok]').onclick = async e => {
    m.err(''); let lines; try { lines = ed.payload(); } catch (er) { return m.err(er.message); }
    const body = {client_uid, kind, lines, service: $('#iSvc', m)?.value, requested_by: $('#iReq', m)?.value, reason: $('#iWhy', m)?.value, supplier_id: $('#iSup', m)?.value};
    const btn = e.currentTarget; btn.classList.add('busy');
    try {
      const r = await api('mouvement', body);
      if (r.hors_ligne) { m.close(); toast('Pas de Wi-Fi : saisie gardée sur ce PC, elle sera envoyée automatiquement', 'ok'); if (S.page === 'sorties') go('sorties'); return; }
      m.close(); await loadRef();
      toast(`${KINDS[kind]} enregistrée — ${da(r.total)}`, 'ok'); if (S.page === 'sorties') go('sorties');
      showDoc('sortie/' + r.id, 'Bon S-' + String(r.id).padStart(5, '0'));
    } catch (er) { m.err(er.message); } finally { btn.classList.remove('busy'); }
  };
}

/* ---------- Stock */
PAGES.stock = async v => {
  await loadRef();
  setTitle('Stock', 'Quantités et valeur au coût moyen pondéré', `<button class="btn" id="stDoc">Imprimer l'état</button><button class="btn" id="stCsv">CSV</button><button class="btn dark" id="stNew">＋ Article</button>`);
  $('#stNew').onclick = () => itemForm(); $('#stDoc').onclick = () => showDoc('stock', 'État du stock'); $('#stCsv').onclick = e => download('export/stock.csv', 'stock.csv', e.target);
  const f = S.params.f || (S.params.f = {q: '', cat: '', alert: false, inactive: false});
  const cats = [...new Set(S.ref.items.map(i => i.category).filter(Boolean))].sort();
  v.innerHTML = `<div class="toolbar"><div class="search"><input id="fq" placeholder="Rechercher un article" value="${esc(f.q)}"></div>
    <select id="fc"><option value="">Toutes catégories</option>${cats.map(c => opt(c, c, f.cat)).join('')}</select>
    <label class="row small"><input type="checkbox" id="fal" ${f.alert ? 'checked' : ''}> Sous le seuil</label><label class="row small"><input type="checkbox" id="fin" ${f.inactive ? 'checked' : ''}> Afficher les désactivés</label></div>
    <div class="card" id="stList"></div>`;
  const draw = () => {
    const q = f.q.toLowerCase();
    const list = S.ref.items.filter(i => (f.inactive || i.active) && (!f.cat || i.category === f.cat) && (!q || i.name.toLowerCase().includes(q)) && (!f.alert || i.min_qty && i.qty <= i.min_qty));
    $('#stList').innerHTML = list.length ? `<div class="tw"><table class="t"><thead><tr><th>Article</th><th>Catégorie</th><th>Conditionnements</th><th class="r">Stock</th><th class="r">Seuil</th><th class="r">Coût moyen</th><th class="r">Valeur</th></tr></thead><tbody>
      ${list.map(i => `<tr class="click" data-id="${i.id}"><td><b>${esc(i.name)}</b>${i.active ? '' : ' <span class="tag">désactivé</span>'}${i.location ? `<div class="muted small">${esc(i.location)}</div>` : ''}</td><td class="muted">${esc(i.category)}</td>
      <td class="small muted">${i.custom_units.map(u => `${esc(u.name)} = ${NB3.format(u.factor)} ${i.base_unit}`).join(', ')}</td>
      <td class="r"><b style="${i.min_qty && i.qty <= i.min_qty ? 'color:var(--bad)' : ''}">${qf(i.qty, i.base_unit)}</b></td><td class="r muted">${i.min_qty ? qf(i.min_qty, i.base_unit) : ''}</td>
      <td class="r">${i.avg_cost ? da(i.avg_cost) + ' / ' + i.base_unit : '—'}</td><td class="r">${da(i.value)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="6">${list.length} article(s)</td><td class="r">${da(list.reduce((a, i) => a + i.value, 0))}</td></tr></tfoot></table></div>` : empty('Aucun article', 'Créez vos articles avec « ＋ Article ».');
    $$('#stList tr[data-id]').forEach(tr => tr.onclick = () => itemDetail(tr.dataset.id));
  };
  let tm; $('#fq').oninput = e => { clearTimeout(tm); tm = setTimeout(() => { f.q = e.target.value; draw(); }, 150); };
  $('#fc').onchange = e => { f.cat = e.target.value; draw(); }; $('#fal').onchange = e => { f.alert = e.target.checked; draw(); }; $('#fin').onchange = e => { f.inactive = e.target.checked; draw(); };
  draw();
};

async function itemDetail(id) {
  const i = itemById(id); const h = await api(`article/${id}/historique`);
  const m = modal({title: esc(i.name), size: 'w3', body: `<div class="grid g4" style="margin-bottom:14px">
    <div class="card kpi"><b>Stock</b><div class="v">${qf(i.qty, i.base_unit)}</div></div><div class="card kpi"><b>Valeur</b><div class="v">${da(i.value)}</div></div>
    <div class="card kpi"><b>Coût moyen</b><div class="v">${i.avg_cost ? da(i.avg_cost) : '—'}</div><div class="s">par ${i.base_unit}</div></div><div class="card kpi"><b>Seuil d'alerte</b><div class="v">${i.min_qty ? qf(i.min_qty, i.base_unit) : '—'}</div></div></div>
    <h3 style="font-size:16px;margin-bottom:6px">Historique des mouvements</h3>
    ${h.length ? `<div class="tw" style="max-height:46vh"><table class="t"><thead><tr><th>Date</th><th>Mouvement</th><th>Service</th><th class="r">Quantité</th><th class="r">Valeur</th><th class="r">Stock après</th><th>Par</th></tr></thead><tbody>
    ${h.map(x => `<tr><td>${fd(x.created_at)}</td><td>${MVK[x.kind]}</td><td>${x.service ? SVC[x.service] : ''}</td><td class="r" style="color:${x.qty > 0 ? 'var(--ok)' : 'var(--bad)'}">${x.qty > 0 ? '+' : ''}${qf(x.qty, i.base_unit)}</td><td class="r">${da(x.value)}</td><td class="r">${qf(x.qty_after, i.base_unit)}</td><td class="muted">${esc(x.who)}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="muted">Aucun mouvement.</div>'}`,
    foot: `<button class="btn dark" data-a="edit">Modifier la fiche</button>`});
  m.querySelector('[data-a=edit]').onclick = () => { m.close(); itemForm(i); };
}

function itemForm(it, opts = {}) {
  const units = it ? it.custom_units.map(u => ({...u})) : [];
  const m = modal({title: it ? 'Modifier l\'article' : 'Nouvel article', size: 'w2', body: `<div class="fields c3">
    <label class="f span2">Nom<input id="aName" value="${esc(it?.name || opts.name || '')}" placeholder="ex. Filet de saumon"></label>
    <label class="f">Catégorie<input id="aCat" list="dl-cats" value="${esc(it?.category || '')}" placeholder="ex. Poissons"></label>
    <label class="f">Unité de stock<select id="aBase" ${it && it.qty ? 'disabled' : ''}>${Object.entries(S.session.base_units).map(([k, l]) => opt(k, `${k} (${l})`, it?.base_unit || 'kg')).join('')}</select></label>
    <label class="f">Seuil d'alerte<input id="aMin" inputmode="decimal" value="${it ? NB3.format(it.min_qty / 1000).replace(/\s/g, '') : ''}" placeholder="0 = aucun"></label>
    <label class="f">Emplacement<input id="aLoc" value="${esc(it?.location || '')}" placeholder="ex. Chambre froide 1"></label>
    ${it ? `<label class="row span4"><input type="checkbox" id="aAct" ${it.active ? 'checked' : ''}> Article actif</label>` : ''}</div>
    <datalist id="dl-cats">${[...new Set(S.ref.items.map(x => x.category).filter(Boolean))].map(c => `<option value="${esc(c)}">`).join('')}</datalist>
    <h3 style="margin:18px 0 4px;font-size:16px">Conditionnements d'achat</h3><p class="muted small" style="margin-top:0">Les conversions standard (kg ↔ g, L ↔ cL ↔ mL) sont automatiques. Ajoutez ici les cartons, sacs, bidons… avec leur contenu.</p>
    <div id="aUnits"></div><button class="btn sm" id="aAddU">＋ Conditionnement</button>`,
    foot: `<button class="btn" data-a="cancel">Annuler</button><button class="btn dark" data-a="ok">Enregistrer</button>`});
  const drawU = () => {
    const b = $('#aBase', m).value;
    $('#aUnits', m).innerHTML = units.map((u, i) => `<div class="row" style="margin-bottom:6px;flex-wrap:nowrap"><input data-i="${i}" data-k="name" value="${esc(u.name)}" placeholder="ex. carton" style="max-width:200px"> <span>=</span>
      <input data-i="${i}" data-k="factor" value="${esc(u.factor)}" inputmode="decimal" placeholder="contenu" style="max-width:140px"> <span>${b}</span><button class="btn sm ghost" data-del="${i}">Retirer</button></div>`).join('') || '<div class="muted small" style="margin-bottom:8px">Aucun.</div>';
    $$('#aUnits input', m).forEach(x => x.oninput = () => units[x.dataset.i][x.dataset.k] = x.value);
    $$('#aUnits [data-del]', m).forEach(x => x.onclick = () => { units.splice(x.dataset.del, 1); drawU(); });
  };
  drawU(); $('#aBase', m).onchange = drawU; $('#aAddU', m).onclick = () => { units.push({name: '', factor: ''}); drawU(); };
  m.querySelector('[data-a=cancel]').onclick = () => m.close();
  m.querySelector('[data-a=ok]').onclick = async e => {
    try {
      const r = await save('article', {id: it?.id, name: $('#aName', m).value, category: $('#aCat', m).value, base_unit: $('#aBase', m).value, min_qty: $('#aMin', m).value || 0,
        location: $('#aLoc', m).value, active: it ? $('#aAct', m).checked : true, units: units.filter(u => u.name || u.factor)}, e.currentTarget);
      m.close(); toast('Article enregistré', 'ok'); await loadRef();
      if (opts.onSaved) opts.onSaved(r.id); else if (S.page === 'stock') go('stock');
    } catch (er) { m.err(er.message); }
  };
}

/* ---------- Fournisseurs */
PAGES.fournisseurs = async v => {
  await loadRef();
  setTitle('Fournisseurs', '', `<button class="btn dark" id="sNew">＋ Fournisseur</button>`);
  $('#sNew').onclick = () => supplierForm(null, () => go('fournisseurs'));
  const debts = {}; (await api('a-payer')).forEach(i => debts[i.supplier_id] = (debts[i.supplier_id] || 0) + i.due);
  v.innerHTML = `<div class="card">${S.ref.suppliers.length ? `<table class="t"><thead><tr><th>Nom</th><th>Contact</th><th>Téléphone</th><th>Notes</th><th class="r">Reste dû</th></tr></thead><tbody>
    ${S.ref.suppliers.map(s => `<tr class="click" data-id="${s.id}"><td><b>${esc(s.name)}</b>${s.active ? '' : ' <span class="tag">désactivé</span>'}</td><td>${esc(s.contact)}</td><td>${esc(s.phone)}</td><td class="muted small">${esc(s.notes)}</td><td class="r">${debts[s.id] ? `<b>${da(debts[s.id])}</b>` : '<span class="muted">—</span>'}</td></tr>`).join('')}
    </tbody></table>` : empty('Aucun fournisseur', 'Ajoutez vos fournisseurs habituels.')}</div>`;
  $$('tr[data-id]', v).forEach(tr => tr.onclick = () => supplierForm(S.ref.suppliers.find(s => s.id == tr.dataset.id), () => go('fournisseurs')));
};
function supplierForm(s, after) {
  const m = modal({title: s ? 'Modifier le fournisseur' : 'Nouveau fournisseur', body: `<div class="fields c2">
    <label class="f span2">Nom<input id="fN" value="${esc(s?.name || '')}"></label><label class="f">Contact<input id="fC" value="${esc(s?.contact || '')}"></label>
    <label class="f">Téléphone<input id="fP" value="${esc(s?.phone || '')}"></label><label class="f span2">Notes<textarea id="fNo">${esc(s?.notes || '')}</textarea></label>
    ${s ? `<label class="row span2"><input type="checkbox" id="fA" ${s.active ? 'checked' : ''}> Fournisseur actif</label>` : ''}</div>`,
    foot: `<button class="btn dark" data-a="ok">Enregistrer</button>`});
  m.querySelector('[data-a=ok]').onclick = async e => {
    try {
      const r = await save('fournisseur', {id: s?.id, name: $('#fN', m).value, contact: $('#fC', m).value, phone: $('#fP', m).value, notes: $('#fNo', m).value, active: s ? $('#fA', m).checked : true}, e.currentTarget);
      m.close(); toast('Fournisseur enregistré', 'ok'); await loadRef(); after && after({id: r.id});
    } catch (er) { m.err(er.message); }
  };
}

/* ---------- Factures */
PAGES.factures = async (v, p) => {
  setTitle('Factures fournisseurs', 'Dettes : montant − avoirs − paiements confirmés', `<button class="btn dark" id="fNew">＋ Facture</button>`);
  $('#fNew').onclick = () => invoiceForm();
  const f = S.params.f || (S.params.f = {etat: 'dues', supplier: '', q: ''});
  const load = async () => {
    const list = await api('factures?' + new URLSearchParams(Object.entries(f).filter(([, x]) => x)));
    $('#invList').innerHTML = list.length ? `<div class="tw"><table class="t"><thead><tr><th>Date</th><th>Fournisseur</th><th>N°</th><th>Bons</th><th>Échéance</th><th class="r">Montant</th><th class="r">Payé</th><th class="r">Reste dû</th><th>Demande</th></tr></thead><tbody>
      ${list.map(i => `<tr class="click" data-id="${i.id}"><td>${fd(i.doc_date)}</td><td>${esc(i.supplier)}</td><td><b>${esc(i.number)}</b>${i.kind === 'solde_initial' ? ' <span class="tag gold">solde initial</span>' : ''}${i.status === 'annulee' ? ' <span class="tag bad">annulée</span>' : ''}</td>
      <td>${i.kind === 'facture' ? (i.nb_bons ? `<span class="tag ${i.ecart ? 'warn' : 'ok'}" title="Écart facture / bons">${i.nb_bons} bon(s)${i.ecart ? ' · écart ' + da(i.ecart) : ''}</span>` : '<span class="tag warn">aucun</span>') : ''}</td>
      <td class="${i.due > 0 && i.due_date && i.due_date < today() ? '' : 'muted'}" style="${i.due > 0 && i.due_date && i.due_date < today() ? 'color:var(--bad);font-weight:600' : ''}">${fd(i.due_date)}</td>
      <td class="r">${da(i.amount)}</td><td class="r muted">${i.paid ? da(i.paid) : ''}</td><td class="r"><b>${i.due ? da(i.due) : '<span class="tag ok">soldée</span>'}</b></td><td>${i.locked_by ? `<span class="tag info">${esc(i.locked_by)}</span>` : ''}</td></tr>`).join('')}
      </tbody><tfoot><tr><td colspan="7">${list.length} facture(s)</td><td class="r">${da(list.reduce((a, i) => a + i.due, 0))}</td><td></td></tr></tfoot></table></div>` : empty(f.etat === 'dues' ? 'Aucune facture à payer' : 'Aucune facture');
    $$('#invList tr[data-id]').forEach(tr => tr.onclick = () => invoiceDetail(tr.dataset.id, load));
  };
  v.innerHTML = `<div class="toolbar"><div class="seg" id="fe"><button data-e="dues" class="${f.etat === 'dues' ? 'on' : ''}">À payer</button><button data-e="" class="${f.etat ? '' : 'on'}">Toutes</button></div>
    <div class="search"><input id="fq" placeholder="N° ou fournisseur" value="${esc(f.q)}"></div><select id="fs">${supplierOptions(f.supplier, true).replace('— Choisir —', 'Tous les fournisseurs')}</select>
    <span class="grow"></span><button class="btn sm" id="csv">Export CSV</button></div><div class="card" id="invList"></div>`;
  $$('#fe button').forEach(b => b.onclick = () => { f.etat = b.dataset.e; $$('#fe button').forEach(x => x.classList.toggle('on', x === b)); load(); });
  $('#fs').onchange = e => { f.supplier = e.target.value; load(); }; let tm; $('#fq').oninput = e => { clearTimeout(tm); tm = setTimeout(() => { f.q = e.target.value; load(); }, 300); };
  $('#csv').onclick = e => download('export/factures.csv', 'factures.csv', e.target);
  await load();
  if (p.nouveau) invoiceForm();
};

function invoiceForm() {
  const m = modal({title: 'Enregistrer une facture', size: 'w2', body: `<div class="seg" id="ivK" style="margin-bottom:12px"><button data-k="facture" class="on">Facture</button><button data-k="solde_initial">Solde initial (ancienne dette)</button></div>
    <div class="fields c2"><label class="f">Fournisseur<select id="ivS">${supplierOptions('')}</select></label><label class="f">N° de facture<input id="ivN"></label>
    <label class="f">Date de la facture<input type="date" id="ivD" value="${today()}" max="${today()}"></label><label class="f">Échéance<input type="date" id="ivE"></label>
    <label class="f">Montant TTC (DA)<input id="ivA" inputmode="decimal"></label><label class="f">Notes<input id="ivNo"></label></div>
    <div id="ivB" style="margin-top:14px"></div>`, foot: `<button class="btn" data-a="cancel">Annuler</button><button class="btn dark" data-a="ok">Enregistrer la facture</button>`});
  let kind = 'facture', recs = [];
  $$('#ivK button', m).forEach(b => b.onclick = () => { kind = b.dataset.k; $$('#ivK button', m).forEach(x => x.classList.toggle('on', x === b)); $('#ivN', m).placeholder = kind === 'facture' ? '' : 'facultatif'; drawB(); });
  const drawB = async () => {
    const s = $('#ivS', m).value;
    if (kind !== 'facture' || !s) { $('#ivB', m).innerHTML = kind === 'facture' ? '<div class="muted small">Choisissez le fournisseur pour rapprocher ses bons de livraison.</div>' : '<div class="alertbox info small">Le solde initial sert à reprendre les dettes existant avant la mise en service du logiciel.</div>'; return; }
    recs = await api(`receptions?supplier=${s}&sans_facture=1`);
    $('#ivB', m).innerHTML = `<h3 style="font-size:16px;margin-bottom:6px">Bons de livraison à rapprocher</h3>` + (recs.length ? `<table class="t"><tbody>${recs.map(r => `<tr><td style="width:30px"><input type="checkbox" data-r="${r.id}"></td><td>${fd(r.doc_date)}</td><td><b>${esc(r.number)}</b></td><td class="r">${da(r.total)}</td></tr>`).join('')}</tbody></table>
      <div class="row" style="justify-content:flex-end;margin-top:8px" id="ivCmp"></div>` : '<div class="muted small">Aucun bon non facturé pour ce fournisseur.</div>');
    $$('#ivB input', m).forEach(x => x.onchange = cmp); cmp();
  };
  const cmp = () => {
    const el = $('#ivCmp', m); if (!el) return;
    const tb = recs.filter(r => $(`#ivB [data-r="${r.id}"]`, m)?.checked).reduce((a, r) => a + r.total, 0);
    const amt = Math.round(parseNum($('#ivA', m).value) * 100);
    el.innerHTML = tb ? `Total des bons : <b>${da(tb)}</b>` + (isFinite(amt) && amt ? (amt === tb ? ' <span class="tag ok">concorde</span>' : ` <span class="tag warn">écart ${da(amt - tb)}</span>`) : '') : '';
  };
  $('#ivS', m).onchange = drawB; $('#ivA', m).oninput = cmp; drawB();
  m.querySelector('[data-a=cancel]').onclick = () => m.close();
  const client_uid = uid();
  const send = async (btn, extra = {}) => {
    const body = {client_uid, kind, supplier_id: $('#ivS', m).value, number: $('#ivN', m).value, doc_date: $('#ivD', m).value, due_date: $('#ivE', m).value, amount: $('#ivA', m).value, notes: $('#ivNo', m).value,
      receipt_ids: $$('#ivB [data-r]', m).filter(x => x.checked).map(x => +x.dataset.r), ...extra};
    if (!body.supplier_id) return m.err('Choisissez le fournisseur');
    btn.classList.add('busy');
    try { const r = await api('facture', body); m.close(); toast('Facture enregistrée', 'ok'); if (S.page === 'factures') go('factures'); invoiceDetail(r.id); }
    catch (e) {
      if (e.body.code === 'doublon_probable') { const why = await confirmBox('Doublon probable', esc(e.message), 'Enregistrer quand même', 'bad', 'Pourquoi ce n\'est pas un doublon ?'); if (why) return send(btn, {force: true, duplicate_reason: why}); }
      else m.err(e.message);
    } finally { btn.classList.remove('busy'); }
  };
  m.querySelector('[data-a=ok]').onclick = e => send(e.currentTarget);
}

async function invoiceDetail(id, after) {
  const i = await api('facture/' + id);
  const m = modal({title: `Facture ${esc(i.number)} — ${esc(i.supplier)}`, size: 'w2', body: `
    ${i.status === 'annulee' ? `<div class="alertbox bad">Facture annulée : ${esc(i.cancel_reason)}</div>` : ''}
    <div class="grid g4" style="margin-bottom:14px"><div class="card kpi"><b>Montant</b><div class="v">${da(i.amount)}</div></div><div class="card kpi"><b>Avoirs</b><div class="v">${da(i.credits.reduce((a, c) => a + c.amount, 0))}</div></div>
    <div class="card kpi"><b>Payé</b><div class="v">${da(i.paid)}</div></div><div class="card kpi ${i.due ? 'alert' : 'good'}"><b>Reste dû</b><div class="v">${da(i.due)}</div></div></div>
    <dl class="kv"><dt>Date</dt><dd>${fd(i.doc_date)}</dd><dt>Échéance</dt><dd>${fd(i.due_date) || '—'}</dd><dt>Saisie par</dt><dd>${esc(i.who)} le ${fd(i.created_at)}</dd>
    <dt>Bons rapprochés</dt><dd>${i.bons.map(b => `<span class="tag">${esc(b.number)} · ${da(b.total)}</span>`).join(' ') || '<span class="tag warn">aucun</span>'} ${i.ecart ? `<span class="tag warn">écart ${da(i.ecart)}</span>` : i.bons.length ? '<span class="tag ok">concorde</span>' : ''}</dd>
    <dt>Demandes</dt><dd>${i.requests.map(r => `${esc(r.number)} ${tag(r.status)}`).join(' ') || '—'}</dd></dl>
    ${i.payments.length ? `<h3 style="font-size:16px;margin:14px 0 6px">Paiements</h3><table class="t"><tbody>${i.payments.map(p => `<tr class="${p.cancel_reason ? 'muted' : ''}"><td>${fd(p.paid_on)}</td><td>${MODES[p.mode]} ${esc(p.reference)}</td><td>${esc(p.request)}</td><td class="r">${p.cancel_reason ? `<s>${da(p.amount)}</s> <span class="tag bad">annulé</span>` : da(p.amount)}</td></tr>`).join('')}</tbody></table>` : ''}
    ${i.credits.length ? `<h3 style="font-size:16px;margin:14px 0 6px">Avoirs</h3><table class="t"><tbody>${i.credits.map(c => `<tr><td>${fd(c.doc_date)}</td><td>${esc(c.number)}</td><td>${esc(c.reason)}</td><td class="r">${da(c.amount)}</td></tr>`).join('')}</tbody></table>` : ''}
    <h3 style="font-size:16px;margin:14px 0 6px">Justificatifs</h3>${attachBlock(i.attachments, 'facture', i.id, i.status === 'active', () => { m.close(); invoiceDetail(id, after); })}`,
    foot: (i.status === 'active' ? (i.kind === 'facture' ? `<button class="btn" data-a="link">Rapprocher des bons</button>` : '') + (i.due ? `<button class="btn" data-a="credit">＋ Avoir</button>` : '') + `<button class="btn bad" data-a="cancel">Annuler la facture…</button>` : '')});
  const b = n => m.querySelector(`[data-a=${n}]`);
  b('credit') && (b('credit').onclick = () => creditForm(i, () => { m.close(); invoiceDetail(id, after); after && after(); }));
  b('link') && (b('link').onclick = async () => {
    const recs = (await api(`receptions?supplier=${i.supplier_id}`)).filter(r => r.status === 'validee' && (!r.invoice || i.bons.some(x => x.id === r.id)));
    const mm = modal({title: 'Rapprocher des bons de livraison', body: recs.length ? `<table class="t"><tbody>${recs.map(r => `<tr><td style="width:30px"><input type="checkbox" data-r="${r.id}" ${i.bons.some(x => x.id === r.id) ? 'checked' : ''}></td><td>${fd(r.doc_date)}</td><td><b>${esc(r.number)}</b></td><td class="r">${da(r.total)}</td></tr>`).join('')}</tbody></table>` : '<div class="muted">Aucun bon disponible.</div>',
      foot: `<button class="btn dark" data-a="ok">Enregistrer</button>`});
    mm.querySelector('[data-a=ok]').onclick = async () => {
      try { const r = await api('facture/rapprocher', {invoice_id: id, receipt_ids: $$('[data-r]', mm).filter(x => x.checked).map(x => +x.dataset.r)}); mm.close(); m.close(); toast(r.ecart ? `Rapproché — écart ${da(r.ecart)}` : 'Rapprochement enregistré', r.ecart ? '' : 'ok'); invoiceDetail(id, after); after && after(); }
      catch (e) { mm.err(e.message); }
    };
  });
  b('cancel') && (b('cancel').onclick = async () => {
    const why = await confirmBox('Annuler la facture', 'La facture ne sera plus comptée dans les dettes. Si elle est dans une demande en brouillon ou à corriger, elle en est retirée. Impossible si la direction l\'a déjà payée.', 'Annuler la facture', 'bad', 'Motif');
    if (!why) return; try { await save('facture/annuler', {invoice_id: id, reason: why}); m.close(); toast('Facture annulée', 'ok'); after && after(); } catch (e) { toast(e.message, 'bad'); }
  });
}
function creditForm(inv, after) {
  const m = modal({title: 'Avoir fournisseur', body: `<div class="fields c2"><label class="f">N° de l'avoir<input id="cN"></label><label class="f">Date<input type="date" id="cD" value="${today()}"></label>
    <label class="f">Montant (DA) — max ${da(inv.due)}<input id="cA" inputmode="decimal"></label><label class="f">Motif<input id="cR" placeholder="ex. marchandise retournée"></label></div>`,
    foot: `<button class="btn dark" data-a="ok">Enregistrer l'avoir</button>`});
  m.querySelector('[data-a=ok]').onclick = async e => {
    try { await save('avoir', {invoice_id: inv.id, number: $('#cN', m).value, doc_date: $('#cD', m).value, amount: $('#cA', m).value, reason: $('#cR', m).value}, e.currentTarget); m.close(); toast('Avoir enregistré', 'ok'); after(); }
    catch (er) { m.err(er.message); }
  };
}

/* ---------- Demandes de paiement */
PAGES.demandes = async (v, p) => {
  setTitle('Demandes de paiement', 'Le magasinier prépare et soumet · la direction approuve puis confirme chaque paiement réel', isMag() ? `<button class="btn dark" id="dNew">＋ Demande de la semaine</button>` : '');
  if (isMag()) $('#dNew').onclick = () => requestForm();
  const list = await api('demandes');
  const groups = isDir() ? [['À valider', l => l.status === 'soumise'], ['Approuvées — paiements à confirmer', l => ['approuvee', 'partiellement_payee'].includes(l.status)], ['Historique', l => !['soumise', 'approuvee', 'partiellement_payee'].includes(l.status)]]
    : [['En cours', l => ['brouillon', 'a_corriger', 'soumise', 'approuvee', 'partiellement_payee'].includes(l.status)], ['Historique', l => !['brouillon', 'a_corriger', 'soumise', 'approuvee', 'partiellement_payee'].includes(l.status)]];
  v.innerHTML = groups.map(([t, fn]) => { const ls = list.filter(fn); return `<div class="card"><div class="hd"><h2>${t}</h2><span class="tag" style="margin-left:auto">${ls.length}</span></div>${ls.length ? `<table class="t"><thead><tr><th>N°</th><th>Semaine</th><th>Statut</th><th>Factures</th><th class="r">Demandé</th><th class="r">Approuvé</th><th class="r">Payé</th><th>Soumise</th></tr></thead><tbody>
    ${ls.map(r => `<tr class="click" data-id="${r.id}"><td><b>${esc(r.number)}</b>${r.revision > 1 ? ` <span class="muted small">rév. ${r.revision}</span>` : ''}</td><td>${fd(r.week_start)} → ${fd(r.week_end)}</td><td>${tag(rst(r))}</td><td>${r.nb}</td><td class="r">${da(r.total)}</td><td class="r">${['approuvee', 'partiellement_payee', 'payee', 'cloturee'].includes(r.status) ? da(r.approved_total) : '—'}</td><td class="r">${r.paid_total ? da(r.paid_total) : '—'}</td><td class="muted">${fd(r.submitted_at)}</td></tr>`).join('')}</tbody></table>` : '<div class="bd muted">Aucune.</div>'}</div>`; }).join('');
  $$('tr[data-id]', v).forEach(tr => tr.onclick = () => requestDetail(+tr.dataset.id));
  if (p.nouveau && isMag()) requestForm();
  if (p.id) requestDetail(p.id);
};

async function requestForm(existing) {
  const pay = await api('a-payer' + (existing ? '?exclure=' + existing.id : ''));
  const sel = {}; (existing?.lines || []).forEach(l => sel[l.invoice_id] = (l.requested / 100).toString());
  const ws = existing ? existing.week_start : null;
  const m = modal({title: existing ? `Corriger la demande ${esc(existing.number)}` : 'Demande de paiement de la semaine', size: 'w3', body: `
    ${existing?.review_comment && existing.status === 'a_corriger' ? `<div class="alertbox bad"><b>Correction demandée par la direction :</b> ${esc(existing.review_comment)}</div>` : ''}
    ${existing ? '' : `<div class="row" style="margin-bottom:10px"><label class="f">Semaine du<input type="date" id="qW" value="${today()}" style="width:180px"></label><span class="muted small" style="margin-top:16px">Les factures antérieures à la semaine sont marquées « ancien solde ».</span></div>`}
    <div class="row" style="margin-bottom:8px"><button class="btn sm" id="qAll">Tout sélectionner</button><button class="btn sm" id="qNone">Tout désélectionner</button><span class="grow"></span><span class="muted small">Montant modifiable pour un paiement partiel</span></div>
    <div id="qTable"></div><label class="f" style="margin-top:12px">Note pour la direction<textarea id="qNote">${esc(existing?.note || '')}</textarea></label>`,
    foot: `<span class="muted" id="qTot"></span><button class="btn" data-a="draft">Enregistrer le brouillon</button><button class="btn dark lg" data-a="submit">Soumettre à la direction</button>`});
  const avail = pay.filter(x => !x.locked_by);
  const locked = pay.filter(x => x.locked_by);
  const weekStart = () => ws || (() => { const d = new Date($('#qW', m).value || today()); const back = (d.getDay() - S.session.settings.week_start + 7) % 7; d.setDate(d.getDate() - back); return d.toISOString().slice(0, 10); })();
  const draw = () => {
    const w = weekStart(); let cur = null, html = '';
    for (const x of avail) {
      if (x.supplier !== cur) { cur = x.supplier; html += `<tr class="sub"><td colspan="7">${esc(cur)}</td></tr>`; }
      const on = sel[x.id] !== undefined;
      html += `<tr><td style="width:30px"><input type="checkbox" data-c="${x.id}" ${on ? 'checked' : ''}></td><td><b>${esc(x.number)}</b>${x.doc_date < w ? ' <span class="tag warn">ancien solde</span>' : ''}${x.kind === 'solde_initial' ? ' <span class="tag gold">solde initial</span>' : ''}</td><td>${fd(x.doc_date)}</td>
        <td class="${x.due_date && x.due_date < today() ? '' : 'muted'}" style="${x.due_date && x.due_date < today() ? 'color:var(--bad)' : ''}">${fd(x.due_date) || '—'}</td><td class="r">${da(x.amount)}</td><td class="r"><b>${da(x.due)}</b></td>
        <td style="width:150px"><input data-a="${x.id}" inputmode="decimal" value="${on ? esc(sel[x.id]) : ''}" placeholder="${NB.format(x.due / 100)}" ${on ? '' : 'disabled'}></td></tr>`;
    }
    $('#qTable', m).innerHTML = (avail.length ? `<div class="tw" style="max-height:48vh"><table class="t"><thead><tr><th></th><th>Facture</th><th>Date</th><th>Échéance</th><th class="r">Montant</th><th class="r">Reste dû</th><th>À payer</th></tr></thead><tbody>${html}</tbody></table></div>` : empty('Aucune facture à payer', 'Enregistrez d\'abord les factures fournisseurs.'))
      + (locked.length ? `<p class="muted small">${locked.length} facture(s) déjà dans une autre demande en cours : ${locked.map(x => `${esc(x.number)} (${esc(x.locked_by)})`).join(', ')}</p>` : '');
    $$('[data-c]', m).forEach(c => c.onchange = () => { const x = avail.find(a => a.id == c.dataset.c); if (c.checked) sel[x.id] = ''; else delete sel[x.id]; draw(); });
    $$('#qTable [data-a]', m).forEach(i => i.oninput = () => { sel[i.dataset.a] = i.value; tot(); });
    tot();
  };
  const tot = () => {
    let t = 0, o = 0; const w = weekStart();
    for (const [id, a] of Object.entries(sel)) { const x = avail.find(z => z.id == id); if (!x) continue; const v = a === '' ? x.due : Math.round(parseNum(a) * 100); if (isFinite(v)) { t += v; if (x.doc_date < w) o += v; } }
    $('#qTot', m).innerHTML = `${Object.keys(sel).length} facture(s) · <b style="color:var(--ink);font-size:17px">${da(t)}</b>${o ? ` dont anciens soldes ${da(o)}` : ''}`;
  };
  if (!existing) $('#qW', m).onchange = draw;
  $('#qAll', m).onclick = () => { avail.forEach(x => { if (sel[x.id] === undefined) sel[x.id] = ''; }); draw(); };
  $('#qNone', m).onclick = () => { Object.keys(sel).forEach(k => delete sel[k]); draw(); };
  draw();
  const client_uid = uid();
  const send = async (submit, btn) => {
    const lines = Object.entries(sel).map(([id, a]) => ({invoice_id: +id, amount: a === '' ? null : a}));
    if (!lines.length) return m.err('Sélectionnez au moins une facture');
    btn.classList.add('busy');
    try {
      const r = await api('demande', {id: existing?.id, client_uid: existing ? undefined : client_uid, week_of: existing ? undefined : $('#qW', m).value, lines, note: $('#qNote', m).value, submit});
      m.close(); toast(submit ? 'Demande soumise à la direction' : 'Brouillon enregistré', 'ok'); go('demandes'); requestDetail(r.id);
    } catch (e) { m.err(e.message); } finally { btn.classList.remove('busy'); }
  };
  m.querySelector('[data-a=draft]').onclick = e => send(false, e.currentTarget);
  m.querySelector('[data-a=submit]').onclick = e => send(true, e.currentTarget);
}

async function requestDetail(id) {
  const r = await api('demande/' + id);
  const st = r.status, canReview = isDir() && st === 'soumise', canPay = isDir() && ['approuvee', 'partiellement_payee'].includes(st);
  const steps = ['brouillon', 'soumise', 'approuvee', 'payee'];
  const stepIdx = {brouillon: 0, a_corriger: 0, soumise: 1, approuvee: 2, partiellement_payee: 2, payee: 3, cloturee: 3, refusee: 1}[st];
  let sup = null, rows = '';
  for (const l of r.lines) {
    if (l.supplier !== sup) { sup = l.supplier; rows += `<tr class="sub"><td colspan="8">${esc(sup)}</td></tr>`; }
    rows += `<tr><td><b>${esc(l.number)}</b>${l.is_old ? ' <span class="tag warn">ancien solde</span>' : ''}</td><td>${fd(l.doc_date)}</td><td class="r">${da(l.due_at_submit)}</td><td class="r"><b>${da(l.requested)}</b></td>
      <td class="r">${canReview ? `<input data-ap="${l.id}" inputmode="decimal" value="${NB.format(l.requested / 100).replace(/\s| /g, '')}" style="width:120px;text-align:right">` : l.approved != null ? da(l.approved) : '—'}</td>
      <td class="r">${l.paid ? da(l.paid) : '—'}</td><td class="r">${canPay && l.reste_a_payer ? `<b>${da(l.reste_a_payer)}</b>` : ''}</td>
      <td class="r">${canPay && l.reste_a_payer ? `<button class="btn sm ok" data-pay="${l.invoice_id}">Confirmer un paiement</button>` : l.approved != null && !l.reste_a_payer && l.paid ? '<span class="tag ok">réglée</span>' : ''}</td></tr>`;
  }
  const m = modal({title: `Demande ${esc(r.number)}`, size: 'w3', body: `
    <div class="row" style="margin-bottom:12px">${tag(rst(r))}<span class="muted">Semaine du ${fd(r.week_start)} au ${fd(r.week_end)} · révision ${r.revision} · préparée par ${esc(r.author)}</span><span class="grow"></span>
    <div class="steps">${steps.map((s, i) => `<span class="${i < stepIdx ? 'done' : i === stepIdx ? 'on' : ''}">${['Préparée', 'Soumise', 'Approuvée', 'Payée'][i]}</span>`).join('›')}</div></div>
    ${r.annulee ? `<div class="alertbox bad"><b>Demande annulée</b> le ${fd(r.closed_at)} — ${esc(r.review_comment.slice(10))}. Ses factures peuvent être remises dans une autre demande.</div>` : ''}
    ${st === 'a_corriger' || st === 'refusee' ? `<div class="alertbox bad"><b>${st === 'refusee' ? 'Refusée' : 'À corriger'} :</b> ${esc(r.review_comment)}</div>` : ''}
    ${['approuvee', 'partiellement_payee'].includes(st) ? '<div class="alertbox info">Approuvée : <b>aucune somme n\'est considérée payée</b> tant que la direction n\'a pas confirmé le règlement réel de chaque facture.</div>' : ''}
    ${r.note ? `<div class="alertbox warn"><b>Note du magasinier :</b> ${esc(r.note)}</div>` : ''}
    <div class="grid g4" style="margin-bottom:14px"><div class="card kpi"><b>Demandé</b><div class="v">${da(r.total_requested)}</div><div class="s">dont anciens soldes ${da(r.total_old)}</div></div>
      <div class="card kpi"><b>Approuvé</b><div class="v">${r.total_approved != null ? da(r.total_approved) : '—'}</div></div><div class="card kpi good"><b>Payé (confirmé)</b><div class="v">${da(r.total_paid)}</div></div>
      <div class="card kpi ${canPay ? 'alert' : ''}"><b>Reste à payer</b><div class="v">${r.total_approved != null ? da(r.lines.reduce((a, l) => a + l.reste_a_payer, 0)) : '—'}</div></div></div>
    <table class="t"><thead><tr><th>Facture</th><th>Date</th><th class="r">Reste dû</th><th class="r">Demandé</th><th class="r">Approuvé</th><th class="r">Payé</th><th class="r">Reste</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    ${r.payments.length ? `<h3 style="font-size:16px;margin:16px 0 6px">Paiements confirmés</h3><table class="t"><tbody>${r.payments.map(p => `<tr class="${p.cancel_reason ? 'muted' : ''}"><td>${fd(p.paid_on)}</td><td>${esc(p.supplier)} · ${esc(p.invoice_number)}</td><td>${MODES[p.mode]} ${esc(p.reference)}</td><td class="muted">${esc(p.by_name)}</td>
      <td class="r">${p.cancel_reason ? `<s>${da(p.amount)}</s> <span class="tag bad" title="${esc(p.cancel_reason)}">annulé</span>` : `<b>${da(p.amount)}</b>`}</td><td class="r">${isDir() && !p.cancel_reason ? `<button class="btn sm ghost" data-cp="${p.id}">Annuler</button>` : ''}</td></tr>`).join('')}</tbody></table>` : ''}
    <h3 style="font-size:16px;margin:16px 0 6px">Justificatifs</h3>${attachBlock(r.attachments, 'demande', r.id, true, () => { m.close(); requestDetail(id); })}
    ${r.history.length ? `<p class="muted small" style="margin-top:14px">Historique : ${r.history.map(h => `${fd(h.at)} ${RST[h.event]?.[0] || h.event} (${esc(h.who)})`).join(' · ')}</p>` : ''}`,
    foot: `<button class="btn" data-a="doc">Aperçu / PDF</button>`
      + (isMag() && ['brouillon', 'a_corriger'].includes(st) ? (st === 'brouillon' && r.revision === 0 ? `<button class="btn ghost" data-a="del">Abandonner</button>` : '') + `<button class="btn" data-a="edit">Modifier</button><button class="btn dark" data-a="submit">Soumettre</button>` : '')
      + (canReview ? `<button class="btn bad" data-a="refuse">Refuser</button><button class="btn" data-a="fix">Demander une correction</button><button class="btn ok lg" data-a="approve">Approuver</button>` : '')
      + (r.can_cancel && !(st === 'brouillon' && r.revision === 0) ? `<button class="btn bad" data-a="annul">Annuler la demande…</button>` : '')
      + (canPay ? `<button class="btn" data-a="close">Clôturer…</button>` : '')});
  const b = n => m.querySelector(`[data-a=${n}]`), reopen = () => { m.close(); go('demandes'); requestDetail(id); refreshBadges(); };
  b('doc').onclick = () => showDoc('demande/' + id, `Demande de paiement ${r.number}`);
  b('edit') && (b('edit').onclick = () => { m.close(); requestForm(r); });
  b('del') && (b('del').onclick = async () => { if (await confirmBox('Abandonner le brouillon', 'Le brouillon sera retiré.', 'Abandonner', 'bad')) { try { await api('demande/abandonner', {request_id: id}); m.close(); go('demandes'); } catch (e) { toast(e.message, 'bad'); } } });
  b('annul') && (b('annul').onclick = async () => { const why = await confirmBox('Annuler la demande', 'La demande sera annulée (tracé au journal) et ses factures redeviendront libres pour une autre demande. Impossible si la direction a déjà payé.', 'Annuler la demande', 'bad', 'Motif'); if (why) { try { await save('demande/annuler', {request_id: id, reason: why}); toast('Demande annulée', 'ok'); reopen(); } catch (e) { toast(e.message, 'bad'); } } });
  b('submit') && (b('submit').onclick = async e => { try { await save('demande/soumettre', {request_id: id}, e.currentTarget); toast('Demande soumise', 'ok'); reopen(); } catch (er) { m.err(er.message); } });
  const decide = async (action, comment) => {
    const approved = {}; $$('[data-ap]', m).forEach(i => approved[i.dataset.ap] = i.value);
    try { await save('demande/decision', {request_id: id, action, comment, approved}); toast({approuver: 'Demande approuvée', refuser: 'Demande refusée', corriger: 'Renvoyée au magasinier'}[action], 'ok'); reopen(); }
    catch (e) { m.err(e.message); }
  };
  b('approve') && (b('approve').onclick = async () => { if (await confirmBox('Approuver la demande', 'L\'approbation autorise les paiements mais <b>n\'est pas un paiement</b> : vous confirmerez ensuite chaque règlement réellement effectué.', 'Approuver', 'ok')) decide('approuver', ''); });
  b('refuse') && (b('refuse').onclick = async () => { const c = await confirmBox('Refuser la demande', 'Les factures redeviennent disponibles pour une prochaine demande.', 'Refuser', 'bad', 'Motif du refus'); if (c) decide('refuser', c); });
  b('fix') && (b('fix').onclick = async () => { const c = await confirmBox('Demander une correction', 'La demande est renvoyée au magasinier.', 'Renvoyer', 'dark', 'Ce qu\'il faut corriger'); if (c) decide('corriger', c); });
  b('close') && (b('close').onclick = async () => { const c = await confirmBox('Clôturer la demande', 'Les montants non payés restent dus et pourront être inclus dans la prochaine demande.', 'Clôturer', 'dark', 'Commentaire'); if (c) { try { await save('demande/cloturer', {request_id: id, comment: c}); reopen(); } catch (e) { toast(e.message, 'bad'); } } });
  $$('[data-pay]', m).forEach(x => x.onclick = () => paymentForm(r, r.lines.find(l => l.invoice_id == x.dataset.pay), reopen));
  $$('[data-cp]', m).forEach(x => x.onclick = async () => { const c = await confirmBox('Annuler le paiement', 'Le montant redevient dû. L\'annulation est tracée.', 'Annuler le paiement', 'bad', 'Motif'); if (c) { try { await save('paiement/annuler', {payment_id: +x.dataset.cp, reason: c}); reopen(); } catch (e) { toast(e.message, 'bad'); } } });
}

function paymentForm(r, l, after) {
  const m = modal({title: 'Confirmer un paiement réel', body: `<div class="alertbox info small">${esc(l.supplier)} · facture <b>${esc(l.number)}</b> · reste à payer <b>${da(l.reste_a_payer)}</b></div>
    <div class="fields c2"><label class="f">Montant payé (DA)<input id="pA" inputmode="decimal" value="${(l.reste_a_payer / 100).toString().replace('.', ',')}"></label><label class="f">Date du paiement<input type="date" id="pD" value="${today()}" max="${today()}"></label>
    <label class="f">Mode<select id="pM">${Object.entries(MODES).map(([k, v]) => opt(k, v)).join('')}</select></label><label class="f">Référence (n° de chèque / virement)<input id="pR"></label>
    <label class="f span2">Note<input id="pN"></label><label class="f span2">Justificatif (reçu, copie du chèque)<input type="file" id="pF" accept="image/*,application/pdf"></label></div>`,
    foot: `<button class="btn" data-a="cancel">Annuler</button><button class="btn ok lg" data-a="ok">Confirmer le paiement</button>`});
  m.querySelector('[data-a=cancel]').onclick = () => m.close();
  const client_uid = uid();
  m.querySelector('[data-a=ok]').onclick = async e => {
    const btn = e.currentTarget; btn.classList.add('busy');
    try {
      const p = await api('paiement', {client_uid, request_id: r.id, invoice_id: l.invoice_id, amount: $('#pA', m).value, paid_on: $('#pD', m).value, mode: $('#pM', m).value, reference: $('#pR', m).value, note: $('#pN', m).value});
      const f = $('#pF', m).files[0]; if (f) { try { await uploadFile(f, 'paiement', p.id); } catch (er) { toast('Paiement enregistré, mais justificatif refusé : ' + er.message, 'bad'); } }
      m.close(); toast(`Paiement confirmé${p.reste ? ' — reste ' + da(p.reste) : ' — facture réglée'}`, 'ok'); after();
    } catch (er) { m.err(er.message); } finally { btn.classList.remove('busy'); }
  };
}

/* ---------- Inventaires */
PAGES.inventaires = async (v, p) => {
  setTitle('Inventaires physiques', 'Comptage, écarts justifiés, ajustement après approbation de la direction', `<button class="btn dark" id="iNew">＋ Nouvel inventaire</button>`);
  $('#iNew').onclick = () => inventoryForm();
  const list = await api('inventaires');
  v.innerHTML = `<div class="card">${list.length ? `<table class="t"><thead><tr><th>N°</th><th>Date</th><th>Par</th><th>Statut</th><th class="r">Articles</th><th class="r">Écarts</th><th>Note</th></tr></thead><tbody>
    ${list.map(i => `<tr class="click" data-id="${i.id}"><td><b>I-${String(i.id).padStart(4, '0')}</b></td><td>${fd(i.created_at)}</td><td>${esc(i.author)}</td><td>${tag(i.status)}</td><td class="r">${i.nb}</td><td class="r">${i.ecarts ? `<span class="tag warn">${i.ecarts}</span>` : '0'}</td><td class="muted">${esc(i.note)}</td></tr>`).join('')}
    </tbody></table>` : empty('Aucun inventaire', 'Lancez un comptage physique du magasin.')}</div>`;
  $$('tr[data-id]', v).forEach(tr => tr.onclick = () => inventoryOpen(+tr.dataset.id));
};
async function inventoryOpen(id) {
  const inv = await api('inventaire/' + id);
  if (inv.status === 'brouillon') return inventoryForm(inv);
  const m = modal({title: `Inventaire I-${String(id).padStart(4, '0')}`, size: 'w3', body: `<div class="row" style="margin-bottom:10px">${tag(inv.status)}<span class="muted">par ${esc(inv.author)} · soumis le ${fd(inv.submitted_at)}</span></div>
    ${inv.lines.some(l => l.moved_since) ? '<div class="alertbox warn small">Des mouvements ont eu lieu depuis le comptage : l\'ajustement appliquera l\'écart constaté au moment du comptage.</div>' : ''}
    <table class="t"><thead><tr><th>Article</th><th class="r">Théorique</th><th class="r">Compté</th><th class="r">Écart</th><th class="r">Valeur</th><th>Raison</th></tr></thead><tbody>
    ${inv.lines.map(l => `<tr><td>${esc(l.name)}</td><td class="r">${qf(l.expected, l.base_unit)}</td><td class="r">${qf(l.counted, l.base_unit)}</td><td class="r" style="color:${l.delta < 0 ? 'var(--bad)' : l.delta > 0 ? 'var(--ok)' : ''}">${l.delta ? (l.delta > 0 ? '+' : '') + qf(l.delta, l.base_unit) : '—'}</td><td class="r">${l.delta ? da(l.delta_value) : ''}</td><td class="small">${esc(l.reason)}</td></tr>`).join('')}
    </tbody><tfoot><tr><td colspan="4">Valeur totale des écarts</td><td class="r">${da(inv.lines.reduce((a, l) => a + (l.delta ? l.delta_value : 0), 0))}</td><td></td></tr></tfoot></table>
    ${inv.review_comment ? `<div class="alertbox info" style="margin-top:12px">${esc(inv.review_comment)}</div>` : ''}`,
    foot: `<button class="btn" data-a="doc">Imprimer / PDF</button>` + (isDir() && inv.status === 'soumis' ? `<button class="btn bad" data-a="rej">Rejeter</button><button class="btn ok lg" data-a="app">Approuver et ajuster le stock</button>` : '')});
  m.querySelector('[data-a=doc]').onclick = () => showDoc('inventaire/' + id, 'Inventaire I-' + String(id).padStart(4, '0'));
  const ap = m.querySelector('[data-a=app]'), rj = m.querySelector('[data-a=rej]');
  ap && (ap.onclick = async e => { if (!await confirmBox('Approuver l\'inventaire', 'Le stock de chaque article sera ajusté de l\'écart constaté (contre-écriture tracée).', 'Approuver', 'ok')) return; try { await save('inventaire/decision', {inventory_id: id, action: 'approuver'}); toast('Inventaire approuvé, stock ajusté', 'ok'); m.close(); await loadRef(); go('inventaires'); refreshBadges(); } catch (er) { toast(er.message, 'bad'); } });
  rj && (rj.onclick = async () => { const c = await confirmBox('Rejeter l\'inventaire', 'Aucun ajustement ne sera fait.', 'Rejeter', 'bad', 'Commentaire'); if (c) { try { await save('inventaire/decision', {inventory_id: id, action: 'rejeter', comment: c}); m.close(); go('inventaires'); refreshBadges(); } catch (er) { toast(er.message, 'bad'); } } });
}
async function inventoryForm(inv) {
  await loadRef();
  const counted = {}; (inv?.lines || []).forEach(l => counted[l.item_id] = {counted: NB3.format(l.counted / 1000).replace(/\s| /g, ''), reason: l.reason});
  const cats = [...new Set(S.ref.items.map(i => i.category).filter(Boolean))].sort();
  let blind = false, cat = '', q = '';
  const m = modal({title: inv ? `Inventaire I-${String(inv.id).padStart(4, '0')} (brouillon)` : 'Nouvel inventaire', size: 'w3', body: `
    <div class="toolbar"><div class="search"><input id="vQ" placeholder="Rechercher"></div><select id="vC"><option value="">Toutes catégories</option>${cats.map(c => opt(c, c)).join('')}</select>
    <label class="row small"><input type="checkbox" id="vB"> Comptage à l'aveugle (masquer le stock théorique)</label><span class="grow"></span><input id="vN" value="${esc(inv?.note || '')}" placeholder="Note (ex. inventaire de fin de mois)" style="min-width:300px"></div>
    <div class="tw" style="max-height:55vh" id="vT"></div><p class="muted small">Saisissez la quantité comptée dans l'unité de stock. Laissez vide les articles non comptés. Tout écart doit être expliqué.</p>`,
    foot: `<span class="muted" id="vS"></span><button class="btn" data-a="save">Enregistrer le brouillon</button><button class="btn dark lg" data-a="submit">Soumettre à la direction</button>`});
  const draw = () => {
    const its = S.ref.items.filter(i => i.active && (!cat || i.category === cat) && (!q || i.name.toLowerCase().includes(q)));
    $('#vT', m).innerHTML = `<table class="t"><thead><tr><th>Article</th><th>Emplacement</th>${blind ? '' : '<th class="r">Théorique</th>'}<th style="width:150px">Compté</th>${blind ? '' : '<th class="r">Écart</th>'}<th>Raison de l'écart</th></tr></thead><tbody>
      ${its.map(i => { const c = counted[i.id] || {}; const n = parseNum(c.counted); const d = c.counted !== undefined && c.counted !== '' && isFinite(n) ? Math.round(n * 1000) - i.qty : null;
        return `<tr><td><b>${esc(i.name)}</b><div class="muted small">${esc(i.category)}</div></td><td class="muted small">${esc(i.location)}</td>${blind ? '' : `<td class="r">${qf(i.qty, i.base_unit)}</td>`}
        <td><div class="row" style="flex-wrap:nowrap;gap:6px"><input data-c="${i.id}" inputmode="decimal" value="${esc(c.counted ?? '')}"><span class="muted">${i.base_unit}</span></div></td>
        ${blind ? '' : `<td class="r" style="color:${d < 0 ? 'var(--bad)' : d > 0 ? 'var(--ok)' : ''}">${d ? (d > 0 ? '+' : '') + qf(d, i.base_unit) : d === 0 ? '✓' : ''}</td>`}
        <td><input data-r="${i.id}" value="${esc(c.reason || '')}" placeholder="${d ? 'obligatoire' : ''}" class="${d && !c.reason ? 'bad' : ''}"></td></tr>`; }).join('')}</tbody></table>`;
    $$('[data-c]', m).forEach(x => x.onchange = () => { (counted[x.dataset.c] ||= {}).counted = x.value; draw(); });
    $$('[data-r]', m).forEach(x => x.oninput = () => { (counted[x.dataset.r] ||= {}).reason = x.value; x.classList.remove('bad'); });
    $('#vS', m).textContent = `${Object.values(counted).filter(c => c.counted !== undefined && c.counted !== '').length} article(s) compté(s)`;
  };
  $('#vB', m).onchange = e => { blind = e.target.checked; draw(); }; $('#vC', m).onchange = e => { cat = e.target.value; draw(); }; $('#vQ', m).oninput = e => { q = e.target.value.toLowerCase(); draw(); };
  draw();
  let invId = inv?.id;
  const send = async (submit, btn) => {
    const lines = Object.entries(counted).map(([id, c]) => ({item_id: +id, counted: c.counted ?? '', reason: c.reason || ''}));
    btn.classList.add('busy');
    try { const r = await api('inventaire', {id: invId, note: $('#vN', m).value, lines, submit}); invId = r.id; toast(submit ? 'Inventaire soumis à la direction' : 'Brouillon enregistré', 'ok'); if (submit) { m.close(); go('inventaires'); } }
    catch (e) { m.err(e.message); } finally { btn.classList.remove('busy'); }
  };
  m.querySelector('[data-a=save]').onclick = e => send(false, e.currentTarget);
  m.querySelector('[data-a=submit]').onclick = e => send(true, e.currentTarget);
}

/* ---------- Rapports */
PAGES.rapports = async v => {
  const f = S.params.f || (S.params.f = {period: 'semaine', date: today(), start: '', end: ''});
  setTitle('Rapports', 'Achats, consommation, dettes et paiements — quatre indicateurs distincts', `<button class="btn" id="rCsv">CSV</button><button class="btn dark" id="rDoc">Aperçu / PDF</button>`);
  const qs = () => new URLSearchParams(Object.entries(f).filter(([, x]) => x)).toString();
  $('#rCsv').onclick = e => download('export/rapport.csv?' + qs(), `rapport-${f.period}-${f.date}.csv`, e.target);
  $('#rDoc').onclick = () => showDoc('rapport?' + qs(), `Rapport ${f.period} ${f.date}`);
  v.innerHTML = `<div class="toolbar"><div class="seg" id="rp">${[['semaine', 'Semaine'], ['mois', 'Mois'], ['libre', 'Période libre']].map(([k, l]) => `<button data-p="${k}" class="${f.period === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <span id="rpd"></span><button class="btn sm" id="rPrev">‹ Précédent</button><button class="btn sm" id="rNext">Suivant ›</button></div><div id="rBody"></div>`;
  const dates = () => { $('#rpd').innerHTML = f.period === 'libre' ? `<input type="date" id="rs" value="${f.start}"> → <input type="date" id="re" value="${f.end}">` : `<input type="date" id="rd" value="${f.date}">`;
    $$('#rpd input').forEach(i => i.onchange = () => { if (i.id === 'rd') f.date = i.value; if (i.id === 'rs') f.start = i.value; if (i.id === 're') f.end = i.value; load(); }); };
  const shift = k => { const d = new Date(f.date); if (f.period === 'mois') d.setMonth(d.getMonth() + k); else d.setDate(d.getDate() + 7 * k); f.date = d.toISOString().slice(0, 10); dates(); load(); };
  $('#rPrev').onclick = () => shift(-1); $('#rNext').onclick = () => shift(1);
  $$('#rp button').forEach(b => b.onclick = () => { f.period = b.dataset.p; if (f.period === 'libre' && !f.start) { f.start = today().slice(0, 8) + '01'; f.end = today(); } $$('#rp button').forEach(x => x.classList.toggle('on', x === b)); dates(); load(); });
  const T = (head, rows, right = []) => rows.length ? `<table class="t"><thead><tr>${head.map((h, i) => `<th class="${right.includes(i) ? 'r' : ''}">${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td class="${right.includes(i) ? 'r' : ''}">${c}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '<div class="bd muted">Rien sur la période.</div>';
  const load = async () => {
    if (f.period === 'libre' && (!f.start || !f.end)) return;
    const R = await api('rapport?' + qs()), t = R.totaux;
    $('#subtitle').textContent = `Du ${fd(R.start)} au ${fd(R.end)}`;
    const maxc = Math.max(1, ...R.consommation.map(x => x.total));
    $('#rBody').innerHTML = `
      <div class="grid g4"><div class="card kpi accent"><b>Achats reçus</b><div class="v">${da(t.achats)}</div><div class="s">marchandises entrées (bons)</div></div>
      <div class="card kpi"><b>Factures enregistrées</b><div class="v">${da(t.factures)}</div><div class="s">dépenses engagées</div></div>
      <div class="card kpi good"><b>Paiements effectués</b><div class="v">${da(t.paiements)}</div><div class="s">confirmés par la direction</div></div>
      <div class="card kpi ${t.dettes ? 'alert' : ''}"><b>Dettes fournisseurs</b><div class="v">${da(t.dettes)}</div><div class="s">au ${fd(R.end)}</div></div></div>
      <div class="grid g2" style="margin-top:16px"><div class="card"><div class="hd"><h2>Consommation par service</h2><b style="margin-left:auto">${da(t.consommation)}</b></div><div class="bd"><div class="bars">
        ${R.consommation.map(x => `<div class="bar"><div class="lbl"><span><span class="svc svc-${x.service}"></span>${esc(x.label)}</span><b>${da(x.total)}</b></div><div class="tr"><div class="fl svc-${x.service}" style="width:${Math.max(0, x.total) / maxc * 100}%"></div></div></div>`).join('')}</div></div></div>
      <div class="card"><div class="hd"><h2>Variation du stock</h2></div><table class="t"><tbody>
        <tr><td>Stock au début</td><td class="r">${da(R.stock_debut)}</td></tr><tr><td>+ Entrées (réceptions)</td><td class="r">${da(R.entrees_stock)}</td></tr><tr><td>− Consommation des services</td><td class="r">${da(t.consommation)}</td></tr>
        <tr><td>− Pertes et retours fournisseurs</td><td class="r">${da(t.pertes)}</td></tr><tr><td>± Écarts d'inventaire</td><td class="r">${da(t.ecarts)}</td></tr></tbody>
        <tfoot><tr><td>= Stock à la fin</td><td class="r">${da(R.stock_fin)}</td></tr></tfoot></table>${R.controle ? `<div class="alertbox bad" style="margin:10px">Écart de contrôle : ${da(R.controle)}</div>` : ''}</div></div>
      <div class="grid g2" style="margin-top:16px">
        <div class="card"><div class="hd"><h2>Achats par fournisseur</h2></div>${T(['Fournisseur', 'Bons', 'Montant'], R.achats.map(x => [esc(x.supplier), x.nb, da(x.total)]), [1, 2])}</div>
        <div class="card"><div class="hd"><h2>Paiements effectués</h2></div>${T(['Fournisseur', 'Mode', 'Montant'], R.paiements.map(x => [esc(x.supplier), MODES[x.mode], da(x.total)]), [2])}</div>
        <div class="card"><div class="hd"><h2>Dettes par fournisseur</h2></div>${T(['Fournisseur', 'Reste dû'], R.dettes.map(x => [esc(x.supplier), da(x.total)]), [1])}</div>
        <div class="card"><div class="hd"><h2>Pertes et écarts d'inventaire</h2></div>${T(['Article', 'Type', 'Quantité', 'Valeur'], [...R.pertes.map(x => [esc(x.item), x.kind === 'perte' ? 'Perte' : 'Retour fourn.', qf(x.qty, x.unit), da(x.total)]), ...R.ecarts.map(x => [esc(x.item), 'Écart inventaire', qf(x.qty, x.unit), da(x.total)])], [2, 3])}</div></div>
      <div class="card" style="margin-top:16px"><div class="hd"><h2>Sorties par article et service</h2></div>${T(['Article', 'Service', 'Quantité', 'Valeur'], R.consommation_articles.map(x => [esc(x.item), `<span class="svc svc-${x.service}"></span>${SVC[x.service]}`, qf(x.qty, x.unit), da(x.total)]), [2, 3])}</div>`;
  };
  dates(); await load();
};

/* ---------- Administration (direction) */
PAGES.comptes = async v => {
  setTitle('Comptes', 'Chaque personne a son propre compte', `<button class="btn dark" id="uNew">＋ Compte</button>`);
  const list = await api('comptes');
  v.innerHTML = `<div class="card"><table class="t"><thead><tr><th>Nom</th><th>Identifiant</th><th>Rôle</th><th>État</th><th>Dernière activité</th><th></th></tr></thead><tbody>
    ${list.map(u => `<tr><td><b>${esc(u.display_name)}</b></td><td>${esc(u.username)}</td><td>${u.role === 'direction' ? '<span class="tag dark">Direction</span>' : '<span class="tag gold">Magasinier</span>'}</td>
    <td>${u.active ? (u.must_change ? '<span class="tag warn">mot de passe provisoire</span>' : '<span class="tag ok">actif</span>') : '<span class="tag bad">désactivé</span>'}</td><td class="muted">${fd(u.last_seen)}</td>
    <td class="r"><button class="btn sm" data-pw="${u.id}">Nouveau mot de passe</button> ${u.id !== S.session.user.id ? `<button class="btn sm" data-act="${u.id}" data-v="${u.active ? 'desactiver' : 'activer'}">${u.active ? 'Désactiver' : 'Réactiver'}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
  $('#uNew').onclick = () => {
    const m = modal({title: 'Nouveau compte', body: `<div class="fields c2"><label class="f">Nom affiché<input id="nN"></label><label class="f">Identifiant<input id="nU" placeholder="ex. karim"></label>
      <label class="f">Rôle<select id="nR">${opt('magasinier', 'Magasinier')}${opt('direction', 'Direction')}</select></label><label class="f">Mot de passe provisoire<input id="nP"></label></div>
      <p class="muted small">La personne devra choisir son propre mot de passe à la première connexion.</p>`, foot: `<button class="btn dark" data-a="ok">Créer</button>`});
    m.querySelector('[data-a=ok]').onclick = async () => { try { await api('compte', {action: 'creer', display_name: $('#nN', m).value, username: $('#nU', m).value, role: $('#nR', m).value, password: $('#nP', m).value}); m.close(); toast('Compte créé', 'ok'); go('comptes'); } catch (e) { m.err(e.message); } };
  };
  $$('[data-pw]', v).forEach(b => b.onclick = async () => { const p = await confirmBox('Nouveau mot de passe provisoire', 'La personne devra le changer à sa prochaine connexion.', 'Enregistrer', 'dark', 'Mot de passe provisoire (10 caractères minimum)'); if (p) { try { await api('compte', {action: 'mot_de_passe', user_id: +b.dataset.pw, password: p}); toast('Mot de passe réinitialisé', 'ok'); go('comptes'); } catch (e) { toast(e.message, 'bad'); } } });
  $$('[data-act]', v).forEach(b => b.onclick = async () => { try { await api('compte', {action: b.dataset.v, user_id: +b.dataset.act}); go('comptes'); } catch (e) { toast(e.message, 'bad'); } });
};
PAGES.journal = async v => {
  setTitle('Journal', 'Toutes les actions, horodatées et chaînées (non modifiable)');
  const j = await api('journal');
  v.innerHTML = `<div class="alertbox ${j.integre ? 'ok' : 'bad'}">${j.integre ? 'Chaîne d\'intégrité vérifiée : aucune entrée n\'a été modifiée ou supprimée.' : `ALERTE : le journal a été altéré à partir de l'entrée ${j.rupture}.`}</div>
    <div class="card"><div class="tw"><table class="t"><thead><tr><th>Date</th><th>Utilisateur</th><th>Action</th><th>Objet</th><th>Détails</th></tr></thead><tbody>
    ${j.entries.map(e => `<tr><td class="muted" style="white-space:nowrap">${fd(e.at)}</td><td>${esc(e.who || 'console')}</td><td>${esc(e.action.replace(/_/g, ' '))}</td><td class="muted">${esc(e.entity)} ${e.entity_id ?? ''}</td><td class="small muted" style="max-width:520px;word-break:break-word">${journalDetails(e.details)}</td></tr>`).join('')}</tbody></table></div></div>`;
};
function journalDetails(s) {
  let d; try { d = JSON.parse(s); } catch (e) { return esc(s); }
  const money = ['amount', 'total', 'valeur'];
  return Object.entries(d).filter(([, x]) => x !== null && x !== '' && !(Array.isArray(x) && !x.length)).map(([k, x]) =>
    `${esc(k.replace(/_/g, ' '))} : <b>${money.includes(k) && typeof x === 'number' ? da(x) : esc(typeof x === 'object' ? JSON.stringify(x) : x)}</b>`).join(' · ');
}
PAGES.sauvegardes = async v => {
  setTitle('Sauvegardes', 'Automatiques toutes les 6 h et chaque soir · vérifiées (intégrité + empreintes)', `<button class="btn dark" id="bNow">Sauvegarder maintenant</button>`);
  const b = await api('sauvegardes');
  v.innerHTML = `${b.state.error ? `<div class="alertbox bad">Dernière erreur : ${esc(b.state.error)}</div>` : ''}
    <div class="card"><div class="bd"><dl class="kv"><dt>Emplacements</dt><dd>${b.dirs.map(esc).join('<br>')}</dd><dt>Conservation</dt><dd>30 jours + la première sauvegarde de chaque mois (12 mois)</dd>
    <dt>Restauration</dt><dd>Sur SRV MB : arrêter le service puis lancer <code>Restaurer une sauvegarde.cmd</code> (l'état actuel est conservé à part).</dd></dl></div></div>
    <div class="card"><table class="t"><thead><tr><th>Date</th><th>Fichier</th><th class="r">Taille</th></tr></thead><tbody>${b.list.map(x => `<tr><td>${esc(x.date)}</td><td class="small">${esc(x.file)}</td><td class="r">${Math.round(x.size / 1024)} Ko</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Aucune sauvegarde.</td></tr>'}</tbody></table></div>`;
  $('#bNow').onclick = async e => { e.target.classList.add('busy'); try { const r = await api('sauvegarde', {}); toast('Sauvegarde vérifiée', 'ok'); go('sauvegardes'); } catch (er) { toast(er.message, 'bad'); } finally { e.target.classList.remove('busy'); } };
};
PAGES.reglages = async v => {
  setTitle('Réglages');
  const days = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
  v.innerHTML = `<div class="card" style="max-width:640px"><div class="hd"><h2>Semaine de travail</h2></div><div class="bd"><label class="f">Premier jour de la semaine (rapports et demandes hebdomadaires)
    <select id="wsS">${days.map((d, i) => opt(i, d, S.session.settings.week_start)).join('')}</select></label><button class="btn dark" id="wsOk" style="margin-top:12px">Enregistrer</button></div></div>
    <div class="card" style="max-width:640px"><div class="hd"><h2>Mise à jour du logiciel</h2></div><div class="bd">
    <div class="small muted" style="margin-bottom:10px">Version installée : <b>${esc(S.session.version)}</b> · PDF serveur : ${S.session.pdf ? 'disponible (Edge)' : 'indisponible — utilisez Imprimer › Enregistrer en PDF'}</div>
    <div id="majInfo" class="small" style="margin-bottom:10px">Vérification de la version disponible…</div>
    <div class="row"><button class="btn" id="majCheck">Vérifier</button><button class="btn dark" id="majGo">Mettre à jour maintenant</button></div>
    <p class="small muted" style="margin:10px 0 0">Le serveur télécharge la dernière version depuis GitHub, l'installe et redémarre tout seul (environ 30 s). Les données ne sont jamais touchées. Une vérification automatique a lieu chaque nuit à 4 h.</p></div></div>`;
  $('#wsOk').onclick = async () => { try { await api('reglages', {week_start: $('#wsS').value}); S.session.settings.week_start = +$('#wsS').value; toast('Réglage enregistré', 'ok'); } catch (e) { toast(e.message, 'bad'); } };
  const majShow = st => {
    const el = $('#majInfo'); if (!el) return;
    if (st.en_cours) { el.innerHTML = `⏳ Mise à jour en cours : ${esc(st.etape)}…`; return; }
    if (st.erreur) { el.innerHTML = `<span style="color:var(--bad)">Échec : ${esc(st.erreur)}</span>`; return; }
    if (st.disponible === null && st.verifie) { el.innerHTML = `GitHub injoignable depuis SRV MB (${esc(st.verifie)})`; return; }
    if (!st.disponible) { el.textContent = 'Version disponible : inconnue'; return; }
    el.innerHTML = st.disponible === st.locale ? `✔ À jour (${esc(st.locale)}) · vérifié ${esc(st.verifie)}` : `Nouvelle version disponible : <b>${esc(st.disponible)}</b> (installée : ${esc(st.locale)})`;
  };
  const majCheck = async () => { try { majShow(await api('mise-a-jour?verifier=1')); } catch (e) { $('#majInfo').textContent = e.message; } };
  $('#majCheck').onclick = majCheck;
  $('#majGo').onclick = async e => {
    if (!confirm('Mettre à jour le logiciel maintenant ? Le serveur sera indisponible environ 30 secondes.')) return;
    e.target.classList.add('busy');
    try {
      majShow(await api('mise-a-jour', {}));
      const v0 = S.session.version; let n = 0;
      const t = setInterval(async () => {
        n++;
        try { const st = await api('mise-a-jour'); if (st.erreur) { majShow(st); clearInterval(t); e.target.classList.remove('busy'); return; } majShow(st); } catch (er) { }
        try { const p = await (await fetch('/api/ping', {cache: 'no-store'})).json(); if (p.version !== v0) { clearInterval(t); toast('Mise à jour installée : version ' + p.version, 'ok'); setTimeout(() => location.reload(), 1500); } } catch (er) { }
        if (n > 90) { clearInterval(t); e.target.classList.remove('busy'); toast('La mise à jour prend plus de temps que prévu : vérifiez dans quelques minutes', 'bad'); }
      }, 2000);
    } catch (er) { toast(er.message, 'bad'); e.target.classList.remove('busy'); }
  };
  majCheck();
};

/* ------------------------------------------------------------------ démarrage */
(async () => {
  if (S.token) { try { await start(); return; } catch (e) { } }
  logout(true); $('#lgErr').textContent = '';
})();

/* ------------------------------------------------------------------ téléphone : menu latéral escamotable */
(() => {
  const t = () => document.body.classList.toggle('menu');
  document.getElementById('burger').onclick = t; document.getElementById('scrim').onclick = t;
})();

/* ------------------------------------------------------------------ prévention : toute erreur d'écran est notée dans le journal du serveur */
(() => {
  const seen = new Set();
  const send = (message, source) => {
    message = String(message || '').slice(0, 400);
    if (!message || seen.has(message) || seen.size >= 8 || !S.token) return; seen.add(message);
    fetch('/api/erreur-client', {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + S.token},
      body: JSON.stringify({message, source: String(source || '').slice(0, 300), page: S.page || '', appareil: navigator.userAgent.slice(0, 160)})}).catch(() => {});
  };
  window.addEventListener('error', e => send(e.message, (e.filename || '').split('/').pop() + ':' + e.lineno + ':' + e.colno));
  window.addEventListener('unhandledrejection', e => { const r = e.reason; if (r instanceof ApiError) return; send(r && r.message || r, r && r.stack ? String(r.stack).split('\n')[1] : ''); });
})();
