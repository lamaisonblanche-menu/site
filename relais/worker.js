// Relais des commandes QR — La Maison Blanche
// Cloudflare Worker + un seul Durable Object (« mb ») qui garde les commandes jusqu'à ce que la caisse les ait reçues.
// Le téléphone parle au relais ; la caisse appelle le relais (connexion sortante). La caisse n'est jamais exposée.
// Secret : CAISSE_SECRET (wrangler secret put CAISSE_SECRET). Rien de secret ne va au navigateur.

const ORIGINES = ['https://lamaisonblanchehydra.com', 'https://www.lamaisonblanchehydra.com'];
const CAISSE_HORS_LIGNE_MS = 120000;   // au-delà, plus de nouvelles commandes (PC éteint, coupure)
const GARDE_MS = 3 * 864e5;            // commandes gardées 3 jours
const LIM = { tableCourt: 20000, tableLong: 6, ipLong: 10, fenetre: 600000, lignes: 40, qte: 20 };

// Coordonnées du restaurant publiées dans les données du site.
const RESTAURANT = { latitude: 36.7401258, longitude: 3.0481449 };
const RAYON_M = 100;
function verifierPosition(position) {
  const { latitude, longitude, accuracy } = position || {};
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 ||
      !Number.isFinite(longitude) || Math.abs(longitude) > 180 ||
      !Number.isFinite(accuracy) || accuracy <= 0) {
    return 'Autorisez la localisation pour envoyer votre demande.';
  }
  if (accuracy > RAYON_M) return 'Position trop imprécise. Activez la localisation précise et réessayez.';
  const rad = degrees => degrees * Math.PI / 180;
  const a = Math.sin(rad(latitude - RESTAURANT.latitude) / 2) ** 2 +
    Math.cos(rad(latitude)) * Math.cos(rad(RESTAURANT.latitude)) *
    Math.sin(rad(longitude - RESTAURANT.longitude) / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(a))) > RAYON_M
    ? 'Vous devez être à moins de 100 m du restaurant pour envoyer votre demande.' : '';
}

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
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.st = ctx.storage; this.ip = new Map(); this.tab = new Map(); this.etat = null; this.file = Promise.resolve(); }

  async charger() { if (!this.etat) this.etat = (await this.st.get('etat')) || { service: null, tables: {}, carte: null, attente: [] }; return this.etat; }

  enSerie(traiter) {
    const demande = this.file.then(traiter);
    this.file = demande.catch(() => {});
    return demande;
  }
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (url.pathname === '/caisse/sync' && req.method === 'POST') return await this.enSerie(() => this.sync(req));
      if (url.pathname === '/api/table' && req.method === 'GET') return await this.table(url);
      if (url.pathname === '/api/carte' && req.method === 'GET') return await this.carte();
      if (url.pathname === '/api/commande' && req.method === 'POST') return await this.enSerie(() => this.commande(req));
      if (url.pathname === '/api/suggestions' && req.method === 'POST') return await this.enSerie(() => this.suggestion(req));
      if (url.pathname === '/api/essais' && req.method === 'GET') return await this.essais(url);
      if (url.pathname === '/api/essais/retour' && req.method === 'POST') return await this.enSerie(() => this.retourEssai(req));
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
    for (const s of (b.statuts || []).slice(0, 500)) {
      if (s.statut !== 'acceptee') continue;
      const c = await this.st.get('c:' + s.id), v = e.suggestions?.[c?.suggestion];
      if (!v) continue;
      const acceptes = (c.attribution || []).filter(l => !(s.retirees || []).includes(l.index)).map(l => l.pid);
      v.acceptes = [...new Set(v.acceptes.concat(acceptes))];
      if (acceptes.length) change = true;
    }
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
    return json({ commandes, acksOk, statutsOk, retoursEssais: e.retoursEssais || [], suiviSuggestions: this.bilanSuggestions(e) });
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
    const { essais, ...carte } = e.carte;
    return json({ ...carte, positionRequise: false, suiviSuggestions: true, service: e.service, caisseEnLigne: this.enLigne() }, 200, { 'Cache-Control': 'private, max-age=5' });
  }
  async suggestion(req) {
    const b = await req.json().catch(() => ({})), e = await this.charger();
    const t = e.tables[b.t || ''];
    if (!t || t.pause || !this.enLigne() || typeof b.id !== 'string' || !/^[a-zA-Z0-9-]{8,60}$/.test(b.id) ||
        !['affichage', 'clic', 'ajout'].includes(b.action) || !Array.isArray(b.produits)) return json({ erreur: 'Suggestion invalide' }, 400);
    const produits = b.produits.slice(0, 2).filter(id => e.carte?.produits.some(p => p.id === id));
    if (!produits.length) return json({ erreur: 'Suggestion invalide' }, 400);
    const recent = Object.fromEntries(Object.entries(e.suggestions || {}).filter(([, v]) => Date.now() - v.ts < 14 * 86400000));
    const ancien = recent[b.id];
    if (!ancien && b.action !== 'affichage') return json({ ok: false }, 409);
    if (ancien && (ancien.salle !== t.salle || ancien.table !== t.table)) return json({ ok: false }, 409);
    if (!ancien && Object.keys(recent).length >= 200) return json({ ok: false }, 429);
    const v = ancien || { ts: Date.now(), salle: t.salle, table: t.table, affiches: [...new Set(produits)], clics: [], ajouts: [], acceptes: [] };
    if (b.action !== 'affichage') {
      const champ = b.action === 'clic' ? 'clics' : 'ajouts';
      v[champ] = [...new Set(v[champ].concat(produits.filter(id => v.affiches.includes(id))))];
    }
    recent[b.id] = v;
    const etat = { ...e, suggestions: recent };
    await this.st.put('etat', etat);
    this.etat = etat;
    return json({ ok: true });
  }
  bilanSuggestions(e) {
    const bilan = new Map();
    for (const v of Object.values(e.suggestions || {})) {
      if (Date.now() - v.ts >= 14 * 86400000) continue;
      for (const id of v.affiches) {
        const k = v.salle + '/' + id;
        const ligne = bilan.get(k) || { salle: v.salle, nom: e.carte?.produits.find(p => p.id === id)?.nom || id, affichages: 0, clics: 0, ajouts: 0, acceptes: 0 };
        ligne.affichages++;
        if (v.clics.includes(id)) ligne.clics++;
        if (v.ajouts.includes(id)) ligne.ajouts++;
        if (v.acceptes.includes(id)) ligne.acceptes++;
        bilan.set(k, ligne);
      }
    }
    return [...bilan.values()];
  }
  offresDisponibles(e) {
    return (e.carte?.essais || []).filter(p => !e.essaisPris?.[p.id]);
  }
  async essais(url) {
    const e = await this.charger(), t = e.tables[url.searchParams.get('t') || ''];
    if (!t || t.pause || !this.enLigne() || !e.service?.ouvert) return json({ produits: [] });
    return json({ produits: this.offresDisponibles(e) });
  }
  essaisAcceptes(c) {
    if (c.statut !== 'acceptee') return [];
    return (c.essais || []).filter(e => !(c.retirees || []).includes(e.index));
  }
  async retourEssai(req) {
    const b = await req.json().catch(() => ({}));
    const e = await this.charger(), c = await this.st.get('c:' + String(b.id || '').slice(0, 40));
    if (!c || c.appareil !== b.appareil) return json({ erreur: 'Commande introuvable' }, 404);
    const plat = this.essaisAcceptes(c).find(p => p.id === b.pid);
    if (!plat) return json({ erreur: 'Plat d’essai introuvable' }, 404);
    const texte = typeof b.texte === 'string' ? b.texte.trim().slice(0, 500) : '';
    if (!texte) return json({ erreur: 'Écrivez un court retour.' }, 400);
    if ((e.retoursEssais || []).some(r => r.pid === plat.id && r.commande === c.id)) return json({ ok: true });
    const retoursEssais = [...(e.retoursEssais || []), { pid: plat.id, commande: c.id, nom: plat.nom, table: c.tableEssai, texte }];
    const etat = { ...e, retoursEssais };
    await this.st.put('etat', etat);
    this.etat = etat;
    return json({ ok: true });
  }
  async commande(req) {
    const b = await req.json().catch(() => ({}));
    const e = await this.charger();
    const sid = String(b.sid || '').slice(0, 60);
    if (!/^[A-Za-z0-9-]{8,60}$/.test(sid)) return json({ erreur: 'Demande invalide' }, 400);
    // même envoi (double clic, réseau coupé puis renvoi) : même réponse, jamais deux commandes
    const deja = await this.st.get('s:' + sid);
    if (deja) {
      const c = await this.st.get('c:' + deja);
      if (c && c.jeton === b.t && c.appareil === String(b.appareil || '').slice(0, 40)) {
        return json({ id: deja, statut: c.statut || 'envoyee' });
      }
      return json({ erreur: 'Identifiant de demande invalide' }, 409);
    }
    const t = e.tables[b.t || ''];
    if (!t) return json({ erreur: 'Ce QR code n’est pas reconnu. Demandez à un serveur.' }, 404);
    if (t.pause) return json({ erreur: 'Les commandes depuis cette table sont suspendues. Un serveur va venir vous voir.' }, 409);
    if (!this.enLigne()) return json({ erreur: 'La commande en ligne est indisponible pour le moment. Un serveur prendra votre commande.' }, 503);
    const type = b.type === 'addition' ? 'addition' : 'commande';
    if (type === 'commande' && e.service && !e.service.ouvert) return json({ erreur: e.service.message || 'Les commandes sont fermées pour le moment.' }, 409);
    // Décision du gérant : ni Wi-Fi ni géolocalisation imposés au client (le contrôle de position de 3.6.1 est retiré).
    // verifierPosition() reste disponible si un jour on veut le réactiver.
    const maint = Date.now();
    if (type === 'addition' && e.additions?.[b.t] && maint - e.additions[b.t] < 60000) {
      return json({ erreur: 'Une addition a déjà été demandée pour cette table. Patientez une minute.' }, 429);
    }
    const lignes = [], essaisChoisis = new Map();
    if (type === 'commande') {
      if (!Array.isArray(b.lignes) || !b.lignes.length || b.lignes.length > LIM.lignes) return json({ erreur: 'Panier vide ou trop grand' }, 400);
      const carte = e.carte || { produits: [], options: [], categories: [] };
      let total = 0;
      for (const l of b.lignes) {
        const essai = this.offresDisponibles(e).find(x => x.id === l.pid);
        if (!essai && (e.essaisPris?.[l.pid] || (carte.essais || []).some(x => x.id === l.pid))) {
          return json({ erreur: 'Cette portion d’essai vient d’être réservée.' }, 409);
        }
        const p = essai || carte.produits.find(x => x.id === l.pid);
        if (!p) return json({ erreur: 'Un article n’est plus à la carte. Rechargez la page.' }, 409);
        if (p.epuise) return json({ erreur: p.nom + ' est épuisé.' }, 409);
        const cat = carte.categories.find(c => c.id === p.cat);
        if (cat && e.service && e.service.univers && e.service.univers[cat.univers] === false) return json({ erreur: p.nom + ' n’est pas servi à cette heure-ci.' }, 409);
        const qte = parseInt(l.qte, 10);
        if (!(qte >= 1 && qte <= LIM.qte)) return json({ erreur: 'Quantité invalide' }, 400);
        if (essai) {
          if (qte !== 1 || essaisChoisis.has(essai.id)) return json({ erreur: 'Une seule portion par plat d’essai.' }, 409);
          essaisChoisis.set(essai.id, { id: essai.id, nom: essai.nom, index: lignes.length });
        }
        const opts = !essai && Array.isArray(l.opts) ? l.opts.slice(0, 12).map(o => ({ g: String(o.g || '').slice(0, 40), i: parseInt(o.i, 10) })) : [];
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
    const v = e.suggestions?.[b.suggestion];
    const attribution = v && v.salle === t.salle && v.table === t.table && Array.isArray(b.suggestionsAjoutees)
      ? lignes.map((l, index) => ({ pid: l.pid, index })).filter(l => v.affiches.includes(l.pid) && b.suggestionsAjoutees.includes(l.pid)) : [];
    const c = { id, sid, type, jeton: b.t, lignes, note: String(b.note || '').slice(0, 200), appareil: String(b.appareil || '').slice(0, 40), client: String(b.client || '').slice(0, 40), ts: maint, recu: 0, statut: 'envoyee', ...(attribution.length ? { suggestion: b.suggestion, attribution } : {}), ...(essaisChoisis.size ? { essais: [...essaisChoisis.values()], tableEssai: t.table } : {}) };
    if (type === 'addition') {
      e.additions = Object.fromEntries(Object.entries(e.additions || {}).filter(([, ts]) => maint - ts < 60000));
      e.additions[b.t] = maint;
    }
    const etat = { ...e, attente: [...(e.attente || []), id] };
    if (essaisChoisis.size) etat.essaisPris = { ...e.essaisPris, ...Object.fromEntries([...essaisChoisis.keys()].map(pid => [pid, id])) };
    await this.st.put({ ['c:' + id]: c, ['s:' + sid]: id, etat });
    this.etat = etat;
    if (type === 'commande') { hT.push(maint); hI.push(maint); this.tab.set(b.t, hT); this.ip.set(ip, hI); }
    return json({ id, statut: 'envoyee' });
  }
  async statut(url) {
    const c = await this.st.get('c:' + (url.searchParams.get('id') || ''));
    if (!c || c.appareil !== (url.searchParams.get('a') || '')) return json({ erreur: 'Commande introuvable' }, 404);
    const statut = c.statut === 'envoyee' ? (c.recu ? 'recue' : 'envoyee') : c.statut;
    return json({ statut, motif: c.motif || '', retirees: c.retirees || [], total: c.total || 0, type: c.type, essais: this.essaisAcceptes(c).map(p => ({ id: p.id, nom: p.nom, retour: (this.etat?.retoursEssais || []).some(r => r.pid === p.id && r.commande === c.id) })) });
  }
}

function egal(a, b) { if (a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; }
