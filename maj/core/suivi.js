'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function dateValide(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
function lireCouts(data) {
  const couts = new Map();
  try {
    const contenu = JSON.parse(fs.readFileSync(path.join(data, 'couts-matiere.json'), 'utf8'));
    for (const c of contenu) {
      if (!c || typeof c.articleId !== 'string' || !dateValide(c.depuis) || !Number.isFinite(c.dinars) || c.dinars < 0 || c.dinars > 1000000) continue;
      const versions = couts.get(c.articleId) || [];
      versions.push({ depuis: c.depuis, centimes: Math.round(c.dinars * 100) });
      couts.set(c.articleId, versions);
    }
    for (const versions of couts.values()) versions.sort((a, b) => b.depuis.localeCompare(a.depuis));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Coûts matière illisibles :', e.message);
    return new Map();
  }
  return couts;
}

const AXES = ['article', 'famille', 'vendeur', 'salle', 'origine', 'statut', 'heure', 'date'];
const TAILLE_PAGE = 100;
const HEURE_ALGER = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Africa/Algiers', hour: '2-digit', hourCycle: 'h23' });
function periode(q, aujourdhui, erreur) {
  const du = q.du || aujourdhui, au = q.au || aujourdhui;
  if (!dateValide(du) || !dateValide(au) || du > au) erreur('Période invalide', 400);
  return [du, au];
}
function lignesVentes(db, q, aujourdhui, erreur, { exportComplet, couts, salleNom }) {
  const [du, au] = periode(q, aujourdhui, erreur);
  const vendeurs = new Map(db.users.map(u => [u.id, u.nom]));
  const jours = new Map(db.jours.map(j => [j.id, j.date]));
  const lignes = [], groupes = new Map();
  const valeurs = Object.fromEntries(AXES.map(k => [k, new Set()]));
  const groupement = AXES.includes(q.grouper) ? q.grouper : 'article';
  const total = () => ({ vendus: 0, offerts: 0, annules: 0, net: 0, remises: 0, valeurOfferte: 0, valeurAnnulee: 0, qteSansCout: 0, qteAvecCout: 0, revenuAvecCout: 0, coutCentimes: 0 });
  const cumulTotal = total();
  function ajouter(l, t, statut, net) {
    const origine = l.source === 'qr' ? 'QR code' : t.salle === 'emporter' ? 'À emporter' : 'Saisie en caisse';
    const cout = statut !== 'Annulé' && !(l.opts || []).some(o => o.prix)
      ? couts.get(l.pid)?.find(c => c.depuis <= t.date) : null;
    const brut = l.prix * l.qte, coutCentimes = cout ? cout.centimes * l.qte : null;
    const saisiA = l.envoye || null;
    const ligne = {
      ticket: t.num ?? null, date: t.date, table: t.table, salle: salleNom(t.salle), saisiA, encaisseA: t.ts || null,
      heure: saisiA ? HEURE_ALGER.formatToParts(saisiA).find(p => p.type === 'hour').value + ' h' : 'Non renseignée',
      article: l.nom, options: (l.opts || []).map(o => o.nom).filter(Boolean).join(', '), famille: l.catNom || 'Sans famille', origine,
      vendeur: origine === 'QR code' ? origine : (l.saisiPar || vendeurs.get(l.par) || 'Non renseigné'),
      caissier: t.caissier, qte: l.qte, prix: l.prix, net, statut, coutCentimes,
      margeCentimes: coutCentimes === null ? null : net * 100 - coutCentimes,
      remise: statut === 'Vendu' ? brut - net : 0,
    };
    for (const cle of AXES) valeurs[cle].add(ligne[cle]);
    if (AXES.some(cle => q[cle] && q[cle] !== ligne[cle])) return;
    lignes.push(ligne);
    const nom = ligne[groupement];
    const groupe = groupes.get(nom) || { nom, ...total() };
    for (const acc of [cumulTotal, groupe]) {
      acc[{ Vendu: 'vendus', Offert: 'offerts', Annulé: 'annules' }[statut]] += l.qte;
      acc.net += net;
      acc.remises += ligne.remise;
      if (statut === 'Offert') acc.valeurOfferte += brut;
      if (statut === 'Annulé') acc.valeurAnnulee += brut;
      else if (coutCentimes === null) acc.qteSansCout += l.qte;
      else { acc.qteAvecCout += l.qte; acc.revenuAvecCout += net; acc.coutCentimes += coutCentimes; }
    }
    groupes.set(nom, groupe);
  }
  const annuleesSurTicket = new Set();
  for (const t of db.tickets) {
    if (t.date < du || t.date > au) continue;
    const eligible = l => !l.offert && !l.annule;
    const base = t.lignes.reduce((n, l) => n + (eligible(l) ? l.prix * l.qte : 0), 0);
    let cumul = 0, reparti = 0;
    for (const l of t.lignes) {
      if (eligible(l)) cumul += l.prix * l.qte;
      const part = base && !t.annule && t.mode !== 'offert' ? Math.round(t.net * cumul / base) : 0;
      const statut = t.annule || l.annule ? 'Annulé' : (l.offert || t.mode === 'offert') ? 'Offert' : 'Vendu';
      if (l.annule && l.id) annuleesSurTicket.add(t.cmdId + '/' + l.id);
      ajouter(l, t, statut, part - reparti);
      reparti = part;
    }
  }
  for (const c of Object.values(db.commandes)) {
    const date = jours.get(c.jour);
    if (!date || date < du || date > au) continue;
    for (const l of c.lignes) {
      if (l.annule && l.envoye && !l.paye && !annuleesSurTicket.has(c.id + '/' + l.id)) {
        ajouter(l, { date, salle: c.salle, table: c.table }, 'Annulé', 0);
      }
    }
  }
  lignes.sort((a, b) => b.date.localeCompare(a.date) || (b.encaisseA || b.saisiA || 0) - (a.encaisseA || a.saisiA || 0));
  const offset = Math.max(0, Number.parseInt(q.offset, 10) || 0);
  const calculMarge = g => ({ ...g, margeCentimes: g.qteAvecCout ? g.revenuAvecCout * 100 - g.coutCentimes : null });
  return {
    du, au, total: lignes.length, offset, lignes: exportComplet ? lignes : lignes.slice(offset, offset + TAILLE_PAGE),
    totaux: calculMarge(cumulTotal),
    filtres: Object.fromEntries(Object.entries(valeurs).map(([k, v]) => [k, [...v].sort((a, b) => a.localeCompare(b, 'fr'))])),
    groupes: [...groupes.values()].map(calculMarge).sort((a, b) => b.net - a.net),
  };
}

function gestionnaire(K) {
  const interfaces = {
    '/': 'suivi.html', '/suivi.js': 'suivi-client.js', '/suivi.css': 'suivi.css',
  };
  const types = { '/': 'text/html', '/suivi.js': 'text/javascript', '/suivi.css': 'text/css' };
  const erreur = (message, code) => { throw Object.assign(new Error(message), { code }); };
  return (req, res, secret, prefixe = '') => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'");
    try {
      if (req.method !== 'GET') erreur('Lecture seule', 405);
      const url = new URL(req.url, 'http://localhost');
      const route = url.pathname.slice(prefixe.length);
      if (Object.hasOwn(interfaces, route)) {
        res.setHeader('Content-Type', types[route] + '; charset=utf-8');
        return res.end(fs.readFileSync(path.join(K.publicDir, interfaces[route])));
      }
      if (route !== '/api/rapports' && route !== '/api/export.csv') erreur('Introuvable', 404);
      if (!secret) erreur('Accès bureau désactivé', 401);
      const attendu = Buffer.from('Bearer ' + secret);
      const auth = Buffer.from(req.headers.authorization || '');
      if (auth.length !== attendu.length || !crypto.timingSafeEqual(auth, attendu)) erreur('Accès aux rapports requis', 401);
      const q = Object.fromEntries(url.searchParams), aujourdHui = K.dateLocale(K.now());
      const [du, au] = periode(q, aujourdHui, erreur);
      const rapport = K.rapportLignes(q, route === '/api/export.csv');
      if (route === '/api/export.csv') {
        const lignes = [['Ticket', 'Date', 'Saisie', 'Encaissement', 'Salle', 'Table', 'Article', 'Options', 'Famille', 'Origine', 'Vendeur', 'Caissier', 'Quantité', 'Prix unitaire DA', 'Remise DA', 'Net DA', 'Statut', 'Coût matière DA', 'Marge matière DA']];
        const horodatage = ts => ts ? new Date(ts).toISOString() : '';
        const dinars = c => c == null ? '' : (c / 100).toFixed(2).replace('.', ',');
        for (const l of rapport.lignes) lignes.push([l.ticket, l.date, horodatage(l.saisiA), horodatage(l.encaisseA), l.salle, l.table, l.article, l.options, l.famille, l.origine, l.vendeur, l.caissier, l.qte, l.prix, l.remise, l.net, l.statut, dinars(l.coutCentimes), dinars(l.margeCentimes)]);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="ventes-' + du + '-' + au + '.csv"');
        return res.end(K.csv(lignes));
      }
      const synthese = K.rapport(du, au);
      const jour = K.jourCourant(false);
      const ouvert = jour && du <= jour.date && au >= jour.date ? K.resumeJour(jour) : null;
      const { ca, especes, cheque, tpe, societe, nbTickets, ticketMoyen, couverts, sorties, jours, heures, precedent, precedentDu, precedentAu } = synthese;
      const rases = synthese.rases.map(({ n, date, ca, attendu, compte, ecart }) => ({ n, date, ca, attendu, compte, ecart }));
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        rapport, synthese: { ca, especes, cheque, tpe, societe, nbTickets, ticketMoyen, couverts, sorties, jours, heures, precedent, precedentDu, precedentAu, rases },
        ouvert: ouvert ? { tables: ouvert.tablesOuvertes, montant: ouvert.montantOuvert } : null,
      }));
    } catch (e) {
      res.statusCode = Number.isInteger(e.code) ? e.code : 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ erreur: res.statusCode === 500 ? 'Rapport indisponible' : e.message }));
      if (res.statusCode === 500) console.error(e);
    }
  };
}

// ---------------------------------------------------------------- Appairage du PC du bureau (3.7.1)
// Le logiciel « Rapports La Maison Blanche » demande l'accès ; le responsable accepte sur la caisse
// (Gestion → Réglages → Rapports du bureau) après avoir vérifié le code à 6 chiffres affiché sur le PC du bureau.
// Seule la clé de LECTURE des rapports est transmise : aucun code ni droit de caisse.
const DUREE_DEMANDE = 10 * 60000, DEMANDES_MAX = 5;
function appairage({ cle, creerCle, nomCaisse, version, signaler, now = Date.now }) {
  const demandes = new Map();
  const purger = () => { for (const [id, d] of demandes) if (now() - d.ts > DUREE_DEMANDE) demandes.delete(id); };
  const envoyer = (res, code, obj) => {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(obj));
  };
  function lire(req) {
    return new Promise(ok => {
      let s = '';
      req.on('data', c => { s += c; if (s.length > 2048) { s = ''; req.destroy(); } });
      req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { ok({}); } });
      req.on('error', () => ok({}));
    });
  }
  // Renvoie true si la requête a été traitée.
  function traiter(req, res, route, url) {
    if (route === '/api/identite' && req.method === 'GET') {
      envoyer(res, 200, { logiciel: 'caisse-la-maison-blanche', nom: nomCaisse(), version: version(), appairage: true, bureauActif: !!cle() });
      return true;
    }
    if (route !== '/api/appairage') return false;
    purger();
    if (req.method === 'POST') {
      lire(req).then(b => {
        const poste = String(b.poste || 'PC du bureau').replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 40) || 'PC du bureau';
        const enAttente = [...demandes.values()].filter(d => d.etat === 'attente');
        if (enAttente.length >= DEMANDES_MAX) return envoyer(res, 429, { erreur: 'Trop de demandes en attente, réessayez dans quelques minutes' });
        const id = crypto.randomBytes(24).toString('hex');
        const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
        demandes.set(id, { id, poste, code, ts: now(), etat: 'attente' });
        signaler(poste, code);
        envoyer(res, 200, { demande: id, code, caisse: nomCaisse(), expire: DUREE_DEMANDE / 1000 });
      });
      return true;
    }
    if (req.method === 'GET') {
      const d = demandes.get(url.searchParams.get('demande') || '');
      if (!d) { envoyer(res, 200, { etat: 'expire' }); return true; }
      if (d.etat === 'accepte') {
        demandes.delete(d.id);
        const c = cle();
        envoyer(res, 200, c ? { etat: 'accepte', cle: c } : { etat: 'refuse' });
        return true;
      }
      if (d.etat === 'refuse') demandes.delete(d.id);
      envoyer(res, 200, { etat: d.etat });
      return true;
    }
    envoyer(res, 405, { erreur: 'Méthode refusée' });
    return true;
  }
  return {
    traiter,
    liste() { purger(); return [...demandes.values()].filter(d => d.etat === 'attente').map(({ id, poste, code, ts }) => ({ id, poste, code, ts })); },
    accepter(id) { purger(); const d = demandes.get(id); if (!d || d.etat !== 'attente') return false; if (!cle()) creerCle(); d.etat = 'accepte'; return true; },
    refuser(id) { const d = demandes.get(id); if (!d || d.etat !== 'attente') return false; d.etat = 'refuse'; return true; },
    toutRefuser() { for (const d of demandes.values()) if (d.etat === 'attente') d.etat = 'refuse'; },
  };
}

function demarrer(K) {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(K.data, 'suivi-srvmb.json'), 'utf8'));
    if (typeof cfg.hote !== 'string' || !cfg.hote || !Number.isInteger(cfg.port) || cfg.port < 1024 || cfg.port > 65535 ||
        typeof cfg.secret !== 'string' || !/^[a-f0-9]{64}$/i.test(cfg.secret)) throw new Error('configuration invalide');
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Suivi SRV MB désactivé :', e.message);
    return;
  }
  const traiter = gestionnaire(K);
  const serveur = http.createServer((req, res) => traiter(req, res, cfg.secret));
  serveur.on('error', e => console.error('Suivi SRV MB indisponible :', e.message));
  serveur.listen(cfg.port, cfg.hote);
}

module.exports = { demarrer, gestionnaire, lignesVentes, lireCouts, appairage };
