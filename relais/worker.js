// Relais des commandes QR — La Maison Blanche
// Cloudflare Worker + un seul Durable Object (« mb ») qui garde les commandes jusqu'à ce que la caisse les ait reçues.
// Le téléphone parle au relais ; la caisse appelle le relais (connexion sortante). La caisse n'est jamais exposée.
// Secret : CAISSE_SECRET (wrangler secret put CAISSE_SECRET). Rien de secret ne va au navigateur.

const ORIGINES = ['https://lamaisonblanchehydra.com', 'https://www.lamaisonblanchehydra.com'];
const CAISSE_HORS_LIGNE_MS = 120000;   // au-delà, plus de nouvelles commandes (PC éteint, coupure)
const GARDE_MS = 3 * 864e5;            // commandes gardées 3 jours
const LIM = { tableCourt: 20000, tableLong: 6, ipLong: 10, fenetre: 600000, lignes: 40, qte: 20 };

const json = (o, st = 200, h = {}) => new Response(JSON.stringify(o), { status: st, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...h } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const cors = (ORIGINES.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin) || (env.ORIGINE_TEST && origin === env.ORIGINE_TEST))
      ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' } : {};
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname === '/') return new Response('Relais La Maison Blanche : OK', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    const id = env.RELAIS.idFromName('mb');
    const r = await env.RELAIS.get(id).fetch(new Request(req, { headers: new Headers({ ...Object.fromEntries(req.headers), 'X-IP': req.headers.get('CF-Connecting-IP') || '' }) }));
    const h = new Headers(r.headers); for (const [k, v] of Object.entries(cors)) h.set(k, v);
    return new Response(r.body, { status: r.status, headers: h });
  },
};

export class Relais {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.st = ctx.storage; this.ip = new Map(); this.tab = new Map(); this.etat = null; }

  async charger() { if (!this.etat) this.etat = (await this.st.get('etat')) || { service: null, tables: {}, carte: null, attente: [] }; return this.etat; }

  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (url.pathname === '/caisse/sync' && req.method === 'POST') return await this.sync(req);
      if (url.pathname === '/api/table' && req.method === 'GET') return await this.table(url);
      if (url.pathname === '/api/carte' && req.method === 'GET') return await this.carte();
      if (url.pathname === '/api/commande' && req.method === 'POST') return await this.commande(req);
      if (url.pathname === '/api/commande' && req.method === 'GET') return await this.statut(url);
      return json({ erreur: 'Inconnu' }, 404);
    } catch (e) { return json({ erreur: 'Erreur du relais' }, 500); }
  }

  // ---------------------------------------------------------- caisse
  async sync(req) {
    const auth = req.headers.get('Authorization') || '';
    if (!this.env.CAISSE_SECRET || !egal(auth, 'Bearer ' + this.env.CAISSE_SECRET)) return json({ erreur: 'Clé du relais incorrecte' }, 401);
    const b = await req.json();
    const e = await this.charger();
    this.vu = Date.now(); // gardé en mémoire : pas d'écriture à chaque appel (quotas gratuits Cloudflare)
    let change = false;
    if (b.service && JSON.stringify(b.service) !== JSON.stringify(e.service)) { e.service = b.service; change = true; }
    if (Array.isArray(b.tables)) { const t = {}; for (const x of b.tables) t[x.jeton] = { salle: x.salle, salleNom: x.salleNom, table: x.table, pause: !!x.pause }; if (JSON.stringify(t) !== JSON.stringify(e.tables)) { e.tables = t; change = true; } }
    if (b.carte) { e.carte = b.carte; change = true; }
    e.attente = e.attente || [];
    const acksOk = [], statutsOk = [];
    for (const id of (b.acks || []).slice(0, 500)) {
      const c = await this.st.get('c:' + id);
      if (c) { if (!c.recu) { c.recu = Date.now(); await this.st.put('c:' + id, c); } acksOk.push(id); }
      if (e.attente.includes(id)) { e.attente = e.attente.filter(x => x !== id); change = true; }
    }
    for (const s of (b.statuts || []).slice(0, 500)) { const c = await this.st.get('c:' + s.id); if (c) { c.statut = s.statut; c.motif = s.motif || ''; c.retirees = s.retirees || []; c.total = s.total || 0; c.decision = Date.now(); await this.st.put('c:' + s.id, c); } statutsOk.push(s.id); }
    // ménage des vieilles commandes, une fois par heure
    if (!e.menage || Date.now() - e.menage > 3600000) {
      e.menage = Date.now(); change = true;
      const vieux = [];
      for (const [k, c] of await this.st.list({ prefix: 'c:' })) if (Date.now() - c.ts > GARDE_MS) vieux.push(k, 's:' + c.sid);
      for (let i = 0; i < vieux.length; i += 128) await this.st.delete(vieux.slice(i, i + 128));
    }
    if (change) await this.st.put('etat', e);
    // commandes pas encore reçues par la caisse (la caisse les dédoublonne par id)
    const commandes = [];
    if (e.attente.length) { const m = await this.st.get(e.attente.map(id => 'c:' + id)); for (const c of m.values()) if (!c.recu) commandes.push({ id: c.id, sid: c.sid, type: c.type, jeton: c.jeton, lignes: c.lignes, note: c.note, appareil: c.appareil, client: c.client, ts: c.ts }); }
    return json({ commandes, acksOk, statutsOk });
  }

  // ---------------------------------------------------------- téléphone
  enLigne() { return Date.now() - (this.vu || 0) < CAISSE_HORS_LIGNE_MS; }
  async table(url) {
    const e = await this.charger(), t = e.tables[url.searchParams.get('t') || ''];
    if (!t) return json({ erreur: 'Ce QR code n’est pas reconnu. Demandez à un serveur.' }, 404);
    return json({ salleNom: t.salleNom, table: t.table, pause: t.pause, service: e.service, caisseEnLigne: this.enLigne() });
  }
  async carte() {
    const e = await this.charger();
    if (!e.carte) return json({ erreur: 'Carte indisponible pour le moment' }, 503);
    return json({ ...e.carte, service: e.service, caisseEnLigne: this.enLigne() }, 200, { 'Cache-Control': 'private, max-age=5' });
  }
  async commande(req) {
    const b = await req.json().catch(() => ({}));
    const e = await this.charger();
    const sid = String(b.sid || '').slice(0, 60);
    if (!/^[A-Za-z0-9-]{8,60}$/.test(sid)) return json({ erreur: 'Demande invalide' }, 400);
    // même envoi (double clic, réseau coupé puis renvoi) : même réponse, jamais deux commandes
    const deja = await this.st.get('s:' + sid);
    if (deja) { const c = await this.st.get('c:' + deja); return json({ id: deja, statut: c ? (c.statut || 'envoyee') : 'envoyee' }); }
    const t = e.tables[b.t || ''];
    if (!t) return json({ erreur: 'Ce QR code n’est pas reconnu. Demandez à un serveur.' }, 404);
    if (t.pause) return json({ erreur: 'Les commandes depuis cette table sont suspendues. Un serveur va venir vous voir.' }, 409);
    if (!this.enLigne()) return json({ erreur: 'La commande en ligne est indisponible pour le moment. Un serveur prendra votre commande.' }, 503);
    const type = b.type === 'addition' ? 'addition' : 'commande';
    if (type === 'commande' && e.service && !e.service.ouvert) return json({ erreur: e.service.message || 'Les commandes sont fermées pour le moment.' }, 409);
    const maint = Date.now();
    let lignes = [];
    if (type === 'commande') {
      if (!Array.isArray(b.lignes) || !b.lignes.length || b.lignes.length > LIM.lignes) return json({ erreur: 'Panier vide ou trop grand' }, 400);
      const carte = e.carte || { produits: [], options: [], categories: [] };
      let total = 0;
      for (const l of b.lignes) {
        const p = carte.produits.find(x => x.id === l.pid);
        if (!p) return json({ erreur: 'Un article n’est plus à la carte. Rechargez la page.' }, 409);
        if (p.epuise) return json({ erreur: p.nom + ' est épuisé.' }, 409);
        const cat = carte.categories.find(c => c.id === p.cat);
        if (cat && e.service && e.service.univers && e.service.univers[cat.univers] === false) return json({ erreur: p.nom + ' n’est pas servi à cette heure-ci.' }, 409);
        const qte = parseInt(l.qte, 10);
        if (!(qte >= 1 && qte <= LIM.qte)) return json({ erreur: 'Quantité invalide' }, 400);
        const opts = Array.isArray(l.opts) ? l.opts.slice(0, 12).map(o => ({ g: String(o.g || '').slice(0, 40), i: parseInt(o.i, 10) })) : [];
        let prix = p.prix;
        for (const o of opts) { const g = carte.options.find(x => x.id === o.g); if (g && g.choix[o.i]) prix += g.choix[o.i].prix || 0; }
        total += prix * qte;
        lignes.push({ pid: p.id, qte, opts, note: String(l.note || '').slice(0, 120) });
      }
      if (carte.montantMax && total > carte.montantMax * 1.5) return json({ erreur: 'Commande trop importante pour être passée en ligne. Un serveur va venir vous voir.' }, 409);
    }
    // limites anti-abus
    const ip = req.headers.get('X-IP') || '?';
    const hT = (this.tab.get(b.t) || []).filter(x => maint - x < LIM.fenetre), hI = (this.ip.get(ip) || []).filter(x => maint - x < LIM.fenetre);
    if (type === 'commande') {
      if (hT.length && maint - hT[hT.length - 1] < LIM.tableCourt) return json({ erreur: 'Une commande vient d’être envoyée pour cette table. Patientez quelques secondes.' }, 429);
      if (hT.length >= LIM.tableLong || hI.length >= LIM.ipLong) return json({ erreur: 'Trop de commandes en peu de temps. Un serveur va venir vous voir.' }, 429);
    }
    const id = 'Q' + maint.toString(36) + Math.random().toString(36).slice(2, 6);
    const c = { id, sid, type, jeton: b.t, lignes, note: String(b.note || '').slice(0, 200), appareil: String(b.appareil || '').slice(0, 40), client: String(b.client || '').slice(0, 40), ts: maint, recu: 0, statut: 'envoyee' };
    e.attente = [...(e.attente || []), id];
    await this.st.put({ ['c:' + id]: c, ['s:' + sid]: id, etat: e });
    hT.push(maint); hI.push(maint); this.tab.set(b.t, hT); this.ip.set(ip, hI);
    return json({ id, statut: 'envoyee' });
  }
  async statut(url) {
    const c = await this.st.get('c:' + (url.searchParams.get('id') || ''));
    if (!c || c.appareil !== (url.searchParams.get('a') || '')) return json({ erreur: 'Commande introuvable' }, 404);
    const statut = c.statut === 'envoyee' ? (c.recu ? 'recue' : 'envoyee') : c.statut;
    return json({ statut, motif: c.motif || '', retirees: c.retirees || [], total: c.total || 0, type: c.type });
  }
}

function egal(a, b) { if (a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; }
