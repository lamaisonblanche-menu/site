// Caisse La Maison Blanche — commandes des clients par QR code (version 3.6.0)
// Principe (voir docs/qr-commandes.md) :
//  - chaque table a un jeton permanent imprimé dans son QR code (https://lamaisonblanchehydra.com/commande/?t=JETON) ;
//  - le téléphone du client envoie sa commande au RELAIS internet (Cloudflare), jamais à la caisse ;
//  - la caisse appelle le relais toutes les 3 s (connexion sortante, aucun port ouvert), récupère les commandes,
//    les écrit sur le disque, puis confirme (accusé) au relais ; une commande n'est jamais ajoutée deux fois (id unique) ;
//  - un serveur, le maître d'hôtel ou un caissier accepte ou refuse ; seule l'acceptation ouvre la table si besoin,
//    ajoute les articles (prix et options recalculés par la caisse) et imprime les bons, par le circuit normal.
//  - sans internet ou si le module est désactivé, la caisse fonctionne exactement comme avant.
'use strict';
const https = require('https');
const http = require('http');
const crypto = require('crypto');

// jetons des 66 tables existantes, fixés une fois pour toutes (les QR imprimés ne changent jamais)
const QR_INITIAUX = {"gastro|1":"8ejd5zw6","gastro|4":"wchvgj36","gastro|7":"kj6dapr9","gastro|8":"ws6n5npq","gastro|11":"3khd7qrz","gastro|12":"snkjs9su","gastro|14":"kxj3cn8a","gastro|15":"km4c4kz3","gastro|16":"3q38cr46","gastro|17":"ss7c3kxc","gastro|18":"eu6zum22","gastro|2":"2eat25fs","gastro|5":"c6yrxpnr","gastro|9":"39evy2y8","gastro|10":"fqrgpjqb","gastro|3":"f53frguq","gastro|6":"n52surhj","brunch|20":"q7mresan","brunch|25":"jjbwk7f4","brunch|33":"kgvxf3t3","brunch|35":"mnfjp2bw","brunch|21":"vqdjnnq9","brunch|26":"vuex4rn9","brunch|32":"kuv5yfyj","brunch|34":"z3nff9h4","brunch|36":"x5mxaw9w","brunch|22":"nhx5fn7s","brunch|27":"udsjynf9","brunch|30":"rkk5y7mv","brunch|31":"6hz59qaf","brunch|37":"ugg56ywy","brunch|23":"d8uuyvat","brunch|28":"5gkdrsav","brunch|38":"sxbb2n2m","brunch|24":"qmnjncux","brunch|29":"9merh625","terrasse|103":"xk3bw873","terrasse|104":"ukfpk9gc","terrasse|105":"gpnnv8g4","terrasse|106":"acpdzj9s","terrasse|107":"2kqka984","terrasse|108":"6ucth63x","terrasse|109":"qw5uxxmq","terrasse|110":"jjqs2mec","terrasse|111":"2hveb24q","terrasse|112":"53bs3hms","terrasse|113":"3wra2sq3","terrasse|114":"tg7wj8z8","terrasse|116":"9yzm4649","terrasse|115":"ujcjsxyu","terrasse|102":"a6eve64v","terrasse|118":"yqy2dq5u","terrasse|117":"nsyfm4g3","terrasse|129":"gu36az3x","terrasse|119":"uhhhzqn6","terrasse|101":"4apcf2dg","terrasse|128":"fha5zcf3","terrasse|127":"ub6me48x","terrasse|121":"ub7cbg2f","terrasse|120":"n5v96hc4","terrasse|122":"ztgk43jw","terrasse|100":"v6mfxvge","terrasse|126":"64h2epx7","terrasse|125":"w5jkrhzv","terrasse|124":"knbqy29u","terrasse|123":"7299ttdv"};
const ALPHA = '23456789abcdefghjkmnpqrstuvwxyz';
const jetonAleatoire = () => [...crypto.randomBytes(8)].map(x => ALPHA[x % ALPHA.length]).join('');
const URL_COMMANDE = 'https://lamaisonblanchehydra.com/commande/?t=';
const ENTETE_BON = '*** COMMANDE CLIENT (QR) ***';

// Une portion en avant-première par recette pendant ce premier essai.
const PLATS_ESSAI = Object.freeze([
  { id: 'essai-spaghettis-burrata-1', nom: 'Spaghettis pesto burrata', prix: 2300, cat: 'pates-fraiches', description: 'Spaghettis au pesto, servis avec une burrata.' },
  { id: 'essai-linguine-crevettes-1', nom: 'Linguine aux crevettes', prix: 2800, cat: 'pates-fraiches', description: 'Linguine aux crevettes et sauce rose.' },
]);
module.exports = function qrCommandes(K) {
  const D = () => K.db();
  const { E, now, save, saveNow, journal, peut, broadcast, salleNom } = K;
  const mn = h => +String(h).slice(0, 2) * 60 + +String(h).slice(3, 5);
  const etatSync = { ok: 0, erreur: '', essai: 0, carteHash: '', carteTs: 0, busy: false };

  function cfg() { return D().config.qr; }
  function estEssai(id) { return PLATS_ESSAI.some(p => p.id === id); }
  function produitsEssai() {
    const db = D();
    for (const p of PLATS_ESSAI) {
      if (!db.produits.some(x => x.id === p.id)) db.produits.push({ ...p, actif: false, stock: 1, options: [] });
    }
  }
  function init() {
    const db = D();
    if (!Array.isArray(db.qrInbox)) db.qrInbox = [];
    for (const demande of db.qrInbox) {
      if (demande.statut !== 'traitement') continue;
      demande.statut = 'attente';
      demande.alertes = [...(demande.alertes || []), 'Traitement interrompu. Vérifiez le bon papier avant de relancer.'];
    }
    if (!db.qrTables || typeof db.qrTables !== 'object') db.qrTables = {};
    db.config.qr = {
      actif: false, relais: '', secret: '', montantMax: 40000,
      ouverture: '09:00', ouvertureVendredi: '16:00', derniereCommande: '22:45',
      horaires: { Brunch: ['09:00', '18:00'], Asiatique: ['11:00', '22:45'] },
      pauses: {}, son: true, essais: false,
      // 'direct' : tout part en cuisine dès l'acceptation (le client commande lui-même ses desserts plus tard) ; 'normal' : suites comme au poste du serveur
      suites: 'direct',
      ...(db.config.qr || {}),
    };
    // 3.6.5 : adresse du relais pré-remplie (publique), il ne reste que la clé secrète à taper
    if (!db.config.qr.relais) db.config.qr.relais = 'https://mb-commandes.lamaisonblanche.workers.dev';
    produitsEssai();
    tablesQr();
  }
  const cle = (s, t) => s + '|' + t;
  // chaque table du plan reçoit un jeton ; une table renommée ou supprimée garde son ancien jeton (marqué « retiré »)
  function tablesQr() {
    const db = D(), par = {};
    let change = false;
    for (const [j, t] of Object.entries(db.qrTables)) if (!t.retire) par[cle(t.salle, t.table)] = j;
    for (const s of db.config.salles) for (const t of s.tables) {
      const k = cle(s.id, String(t.n));
      if (par[k]) continue;
      const ancien = Object.entries(db.qrTables).find(([, x]) => x.retire && cle(x.salle, x.table) === k);
      if (ancien) { ancien[1].retire = false; par[k] = ancien[0]; change = true; continue; }
      let j = QR_INITIAUX[k];
      if (!j || db.qrTables[j]) do j = jetonAleatoire(); while (db.qrTables[j]);
      db.qrTables[j] = { salle: s.id, table: String(t.n), cree: now() }; par[k] = j; change = true;
    }
    for (const t of Object.values(db.qrTables)) {
      const s = db.config.salles.find(x => x.id === t.salle);
      const existe = !!(s && s.tables.some(x => String(x.n) === t.table));
      if (!existe && !t.retire) { t.retire = true; change = true; }
    }
    if (change) save();
  }
  function jetonDe(salle, table) { const e = Object.entries(D().qrTables).find(([, t]) => !t.retire && t.salle === salle && t.table === String(table)); return e ? e[0] : null; }

  // ------------------------------------------------------------ horaires
  function service(d = new Date()) {
    const c = cfg(), m = d.getHours() * 60 + d.getMinutes(), vendredi = d.getDay() === 5;
    const deb = vendredi ? c.ouvertureVendredi : c.ouverture;
    const ouvert = m >= mn(deb) && m <= mn(c.derniereCommande);
    const univers = {};
    for (const [u, [a, b]] of Object.entries(c.horaires || {})) univers[u] = ouvert && m >= Math.max(mn(a), mn(deb)) && m <= mn(b);
    return { ouvert, univers, message: ouvert ? '' : 'Les commandes depuis la table sont possibles de ' + deb + ' à ' + c.derniereCommande + '.' };
  }
  function universDe(pid) { const db = D(); const p = db.produits.find(x => x.id === pid); const k = p && db.categories.find(c => c.id === p.cat); return (k && k.univers) || 'La carte'; }
  function horsHoraire(pid, srv) { const u = universDe(pid); return srv.univers[u] === false; }

  // ------------------------------------------------------------ carte envoyée au relais (lue par le téléphone)
  function carte() {
    const db = D();
    const visible = p => p.actif !== false && !estEssai(p.id) && p.id !== 'supplement-fixe' && !p.horsQr;
    const cats = db.categories.filter(c => db.produits.some(p => p.cat === c.id && visible(p))).sort((a, b) => a.ordre - b.ordre);
    const ids = new Set(cats.map(c => c.id));
    return {
      categories: cats.map(c => ({ id: c.id, nom: c.nom, univers: c.univers || 'La carte', suite: c.suite || 0 })),
      produits: db.produits.filter(p => visible(p) && ids.has(p.cat)).map(p => ({ id: p.id, nom: p.nom, prix: p.prix, cat: p.cat, options: (p.options || []).filter(g => db.options.some(o => o.id === g)), epuise: p.stock !== null && p.stock !== undefined && p.stock <= 0 })),
      options: db.options.map(o => ({ id: o.id, nom: o.nom, obligatoire: !!o.obligatoire, multiple: !!o.multiple, choix: o.choix.map(ch => ({ nom: ch.nom, prix: Math.round(+ch.prix || 0) })) })),
      top: (K.topVentes() || []).slice(0, 12),
      montantMax: cfg().montantMax,
      essais: cfg().essais ? PLATS_ESSAI.filter(p => db.categories.some(c => c.id === p.cat) &&
        db.produits.find(x => x.id === p.id)?.stock === 1) : [],
    };
  }
  function tablesPourRelais() {
    const db = D(), p = cfg().pauses || {};
    return Object.entries(db.qrTables).filter(([, t]) => !t.retire).map(([j, t]) => ({ jeton: j, salle: t.salle, salleNom: salleNom(t.salle), table: t.table, pause: !!p[j] }));
  }

  // ------------------------------------------------------------ réception d'une commande du relais
  const signature = ls => JSON.stringify((ls || []).map(l => [l.pid, l.qte, l.opts, l.note]).sort());
  function nettoyer(lignes) {
    if (!Array.isArray(lignes)) return [];
    return lignes.slice(0, 40).map(l => ({
      pid: String(l.pid || '').slice(0, 60), qte: Math.max(1, Math.min(20, parseInt(l.qte, 10) || 1)),
      opts: Array.isArray(l.opts) ? l.opts.slice(0, 12).map(o => ({ g: String(o.g || '').slice(0, 40), i: parseInt(o.i, 10) })) : [],
      note: String(l.note || '').slice(0, 120),
    }));
  }
  function evaluer(it) {
    const db = D(), c = cfg(), al = [];
    it.alertes = al; it.invalide = false;
    const t = db.qrTables[it.jeton];
    if (!t) { al.push('QR code inconnu'); it.invalide = true; return; }
    if (t.retire) al.push('Ce QR code correspond à une ancienne table (' + salleNom(t.salle) + ' ' + t.table + ')');
    if ((c.pauses || {})[it.jeton]) al.push('Table en pause pour les commandes QR');
    if (it.type === 'addition') return;
    const srv = service(new Date(it.recu));
    if (!srv.ouvert) al.push('Commande reçue hors des horaires');
    for (const l of it.lignes) if (horsHoraire(l.pid, srv)) { const p = db.produits.find(x => x.id === l.pid); al.push((p ? p.nom : 'Article') + ' : hors horaires (' + universDe(l.pid) + ')'); }
    try { const ls = K.verifierLignes({ salle: it.salle }, it.lignes, { source: 'qr' }); it.montant = ls.reduce((s, l) => s + l.prix * l.qte, 0); it.detail = ls.map(l => ({ nom: l.nom, qte: l.qte, prix: l.prix, opts: l.opts.map(o => o.nom), note: l.note })); }
    catch (e) { al.push(e.message); it.invalide = true; it.detail = it.lignes.map(l => { const p = db.produits.find(x => x.id === l.pid); return { nom: p ? p.nom : '(article supprimé)', qte: l.qte, prix: p ? p.prix : 0, opts: [], note: l.note }; }); it.montant = it.detail.reduce((s, l) => s + l.prix * l.qte, 0); }
    if (it.montant > (+c.montantMax || 40000)) al.push('Montant élevé : ' + it.montant + ' DA');
    const ouverte = Object.values(db.commandes).find(x => x.statut === 'ouverte' && x.salle === it.salle && x.table === it.table);
    it.premiere = !ouverte; // première commande : la table s'ouvrira à l'acceptation (information, pas une alerte)
    const h = new Date(it.recu), m = h.getHours() * 60 + h.getMinutes(), auj = K.dateLocale(it.recu);
    const r = (db.reservations || []).find(x => x.date === auj && x.salle === it.salle && x.table === it.table && x.statut === 'prevue' && m >= mn(x.heure) - 30 && m <= mn(x.heure) + 60);
    if (r) al.push('Table réservée à ' + r.heure + ' (' + r.nom + ')');
    const sig = signature(it.lignes);
    if (db.qrInbox.some(x => x !== it && x.jeton === it.jeton && x.type === 'commande' && ['attente', 'acceptee'].includes(x.statut) && it.recu - x.recu < 180000 && signature(x.lignes) === sig)) al.push('Doublon probable : même commande il y a moins de 3 min');
  }
  function recevoir(cmd) {
    const db = D();
    if (!cmd || !cmd.id || db.qrInbox.some(x => x.id === cmd.id)) return false;
    const t = db.qrTables[cmd.jeton];
    const it = {
      id: String(cmd.id).slice(0, 40), sid: String(cmd.sid || '').slice(0, 60), type: cmd.type === 'addition' ? 'addition' : 'commande',
      jeton: String(cmd.jeton || '').slice(0, 20), salle: t ? t.salle : null, table: t ? t.table : null,
      lignes: nettoyer(cmd.lignes), note: String(cmd.note || '').slice(0, 200), appareil: String(cmd.appareil || '').slice(0, 40),
      client: String(cmd.client || '').slice(0, 40), recu: now(), creeRelais: +cmd.ts || null, statut: 'attente', ack: false,
    };
    evaluer(it);
    db.qrInbox.push(it);
    const limite = now() - 7 * 864e5;
    if (db.qrInbox.length > 300) db.qrInbox = db.qrInbox.filter(x => x.recu > limite || x.statut === 'attente');
    journal(null, 'QR reçu', (it.type === 'addition' ? 'Addition demandée' : 'Commande') + ' ' + (it.salle ? salleNom(it.salle) + ' ' + it.table : 'table inconnue') + (it.alertes.length ? ' — ' + it.alertes.join(' ; ') : ''));
    return true;
  }

  // ------------------------------------------------------------ synchronisation avec le relais
  function appeler(url, corps, secret) {
    return new Promise((resolve, reject) => {
      let u; try { u = new URL(url); } catch (e) { return reject(new Error('Adresse du relais invalide')); }
      const data = Buffer.from(JSON.stringify(corps));
      const lib = u.protocol === 'http:' ? http : https;
      if (u.protocol === 'http:' && !/^(localhost|127\.)/.test(u.hostname)) return reject(new Error('Le relais doit être en https'));
      const req = lib.request(u, { method: 'POST', timeout: 8000, headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, Authorization: 'Bearer ' + secret } }, res => {
        let b = ''; res.setEncoding('utf8'); res.on('data', x => { b += x; if (b.length > 2e6) req.destroy(); });
        res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} if (res.statusCode !== 200) return reject(new Error((j && j.erreur) || 'Relais : erreur ' + res.statusCode)); resolve(j || {}); });
      });
      req.on('timeout', () => req.destroy(new Error('Relais injoignable (délai dépassé)')));
      req.on('error', e => reject(new Error('Relais injoignable : ' + (e.code || e.message))));
      req.end(data);
    });
  }
  function statutsAEnvoyer() {
    return D().qrInbox.filter(x => x.statut !== 'attente' && x.statut !== 'traitement' && !x.statutOk).slice(-100).map(x => ({ id: x.id, statut: x.statut, motif: x.motif || '', retirees: x.retirees || [], total: x.montantAccepte || 0 }));
  }
  async function sync() {
    const db = D(), c = cfg();
    if (!c.actif || !c.relais || !c.secret || etatSync.busy) return;
    etatSync.busy = true; etatSync.essai = now();
    try {
      const ct = carte(), h = crypto.createHash('sha256').update(JSON.stringify(ct)).digest('hex').slice(0, 16);
      const envoyerCarte = h !== etatSync.carteHash || now() - etatSync.carteTs > 600000;
      const acks = db.qrInbox.filter(x => !x.ack).map(x => x.id).slice(-200);
      const corps = { version: K.VERSION, heure: now(), service: service(), tables: tablesPourRelais(), acks, statuts: statutsAEnvoyer(), carteHash: h, carte: envoyerCarte ? ct : undefined };
      const r = await appeler(c.relais.replace(/\/+$/, '') + '/caisse/sync', corps, c.secret);
      if (envoyerCarte) { etatSync.carteHash = h; etatSync.carteTs = now(); }
      let change = false;
      for (const id of r.acksOk || []) { const x = db.qrInbox.find(y => y.id === id); if (x && !x.ack) { x.ack = true; change = true; } }
      for (const id of r.statutsOk || []) { const x = db.qrInbox.find(y => y.id === id); if (x && !x.statutOk) { x.statutOk = true; change = true; } }
      let nv = 0;
      for (const cmd of r.commandes || []) if (recevoir(cmd)) nv++;
      if (Array.isArray(r.retoursEssais) && JSON.stringify(db.retoursEssaisQr || []) !== JSON.stringify(r.retoursEssais)) {
        db.retoursEssaisQr = r.retoursEssais;
        change = true;
      }
      if (Array.isArray(r.suiviSuggestions) && JSON.stringify(db.suiviSuggestionsQr || []) !== JSON.stringify(r.suiviSuggestions)) {
        db.suiviSuggestionsQr = r.suiviSuggestions;
        change = true;
      }
      if (nv) { saveNow(); broadcast(); } else if (change) save();
      etatSync.ok = now(); etatSync.erreur = '';
    } catch (e) { etatSync.erreur = e.message; }
    finally { etatSync.busy = false; }
  }

  // ------------------------------------------------------------ état pour les écrans (serveurs, maître d'hôtel, caisse)
  function etat(u) {
    // 3.7.8 : serveurs, maître d'hôtel et caissiers voient et valident les commandes QR (demande du gérant ; 3.7.4 l'avait réservé aux caissiers)
    if (!peut(u, 'serveur')) return null;
    const c = cfg(), limite = now() - 12 * 3600000;
    return {
      actif: !!c.actif, configure: !!(c.relais && c.secret), enLigne: !!c.actif && now() - etatSync.ok < 20000, erreur: c.actif ? etatSync.erreur : '', son: c.son !== false,
      attente: D().qrInbox.filter(x => x.recu > limite && (x.statut === 'attente' || x.statut === 'traitement' || (x.statut === 'acceptee' && !impressionsEnCours.has(x.id) && x.echecs && x.echecs.length && !x.echecsVu)))
        .slice(-40).map(x => ({ id: x.id, type: x.type, salle: x.salle, salleNom: x.salle ? salleNom(x.salle) : '?', table: x.table, recu: x.recu, statut: x.statut, detail: x.detail || [], note: x.note, montant: x.montant || 0, alertes: x.alertes || [], premiere: !!x.premiere, invalide: !!x.invalide, echecs: x.echecs || [], client: x.client || '' })),
      pauses: c.pauses || {},
    };
  }
  function trouver(id) { const it = D().qrInbox.find(x => x.id === id); if (!it) E('Demande introuvable', 404); return it; }
  const ouverteDe = it => Object.values(D().commandes).find(x => x.statut === 'ouverte' && x.salle === it.salle && x.table === it.table);

  const R = K.routes;
  const impressionsEnCours = new Set();
  R['POST /api/qr/accepter'] = async (b, u) => {
    if (!peut(u, 'serveur')) E('Non autorisé', 403);
    const it = trouver(b.id);
    if (it.statut !== 'attente') E(it.statut === 'traitement' ? 'Déjà en cours d’acceptation sur un autre écran' : 'Déjà traitée' + (it.decision ? ' par ' + it.decision.par : ''));
    if (!it.salle) E('QR code inconnu : refusez cette demande');
    if (it.type === 'addition') {
      const c = ouverteDe(it); if (!c) E('Pas de commande ouverte sur cette table');
      it.statut = 'traitement';
      try {
        const r = await R['POST /api/commande/addition']({ id: c.id }, u);
        if (r.erreurs.length) {
          it.statut = 'attente';
          it.alertes = r.erreurs;
          saveNow();
          broadcast();
          return { ok: false, erreurs: r.erreurs };
        }
        it.statut = 'vue'; it.decision = { par: u.nom, ts: now() }; it.cmdId = c.id; save();
        return { ok: true, erreurs: (r && r.erreurs) || [] };
      } catch (e) { it.statut = 'attente'; throw e; }
    }
    const retirer = Array.isArray(b.retirer) ? b.retirer.map(Number) : [];
    const lignes = it.lignes.filter((_, i) => !retirer.includes(i));
    if (!lignes.length) E('Aucun article à accepter : refusez la commande');
    if (cfg().suites !== 'normal') for (const l of lignes) l.suite = 0;
    K.verifierLignes({ salle: it.salle }, lignes, { source: 'qr' }); // contrôle complet AVANT de toucher à la table (stock, options, cuissons)
    it.statut = 'traitement';
    impressionsEnCours.add(it.id);
    try {
      let c = ouverteDe(it);
      if (!c) c = R['POST /api/commande/ouvrir']({ salle: it.salle, table: it.table, couverts: 1, pin: b.pin }, u);
      if (it.note && !c.note) c.note = 'Client : ' + it.note.slice(0, 100);
      const r = await K.envoyerLignes(c, lignes, u, {
        source: 'qr', entete: ENTETE_BON, durable: true, signalerSimulation: true, // 3.7.8 : imprimante sans adresse = bon à refaire, pas « imprimé »
        avantImpression: (ls, bons) => {
          it.bonsRestants = bons.map(({ poste, doc }) => ({ poste, texte: doc.texte(), base64: doc.buf().toString('base64') }));
          it.echecs = it.bonsRestants.map(bon => bon.poste);
          it.statut = 'acceptee'; it.cmdId = c.id; it.decision = { par: u.nom, ts: now() }; it.retirees = retirer; it.montantAccepte = ls.reduce((s, l) => s + l.prix * l.qte, 0);
        },
        apresImpression: poste => marquerBonImprime(it, poste),
      });
      journal(u, 'QR accepté', salleNom(it.salle) + ' ' + it.table + ' — ' + it.montantAccepte + ' DA' + (retirer.length ? ' (' + retirer.length + ' article(s) retiré(s))' : ''));
      return { ok: true, erreurs: r.erreurs, cmdId: c.id };
    } catch (e) { if (it.statut === 'traitement') it.statut = 'attente'; throw e; }
    finally { impressionsEnCours.delete(it.id); broadcast(); }
  };
  function marquerBonImprime(it, poste) {
    it.bonsRestants = it.bonsRestants.filter(bon => bon.poste !== poste);
    it.echecs = it.bonsRestants.map(bon => bon.poste);
    saveNow();
  }
  R['POST /api/qr/reimprimer'] = async (b, u) => {
    if (!peut(u, 'serveur')) E('Non autorisé', 403);
    const it = trouver(b.id);
    if (it.statut !== 'acceptee' || !it.bonsRestants?.length) E('Aucun bon disponible pour la réimpression ciblée');
    if (impressionsEnCours.has(it.id)) E('Impression déjà en cours');
    const erreurs = [];
    impressionsEnCours.add(it.id);
    try {
      for (const bon of it.bonsRestants) {
        const r = await K.imprimer(bon.poste, { buf: () => Buffer.from(bon.base64, 'base64'), texte: () => bon.texte });
        if (r.ok) marquerBonImprime(it, bon.poste);
        else erreurs.push(r.erreur);
      }
      journal(u, 'QR réimpression', salleNom(it.salle) + ' ' + it.table);
      save();
      return { erreurs };
    } finally { impressionsEnCours.delete(it.id); broadcast(); }
  };
  R['POST /api/qr/refuser'] = (b, u) => {
    if (!peut(u, 'serveur')) E('Non autorisé', 403);
    const it = trouver(b.id);
    if (it.statut !== 'attente') E('Déjà traitée');
    it.statut = it.type === 'addition' ? 'vue' : 'refusee'; it.motif = String(b.motif || '').slice(0, 120); it.decision = { par: u.nom, ts: now() };
    journal(u, it.type === 'addition' ? 'QR addition vue' : 'QR refusé', (it.salle ? salleNom(it.salle) + ' ' + it.table : '?') + (it.motif ? ' — ' + it.motif : ''));
    save(); return { ok: true };
  };
  R['POST /api/qr/vu-impression'] = (b, u) => { if (!peut(u, 'serveur')) E('Non autorisé', 403); const it = trouver(b.id); it.echecsVu = true; save(); return { ok: true }; };
  R['POST /api/qr/pause'] = (b, u) => {
    if (!peut(u, 'caissier')) E('Réservé aux caissiers', 403);
    const j = b.jeton || jetonDe(b.salle, b.table); if (!j || !D().qrTables[j]) E('Table inconnue');
    const p = cfg().pauses = cfg().pauses || {};
    if (b.pause) p[j] = now(); else delete p[j];
    const t = D().qrTables[j];
    journal(u, b.pause ? 'QR table en pause' : 'QR table réactivée', salleNom(t.salle) + ' ' + t.table);
    save(); return { ok: true, pauses: p };
  };
  R['GET /api/qr/admin'] = (b, u) => {
    if (!peut(u, 'admin')) E('Réservé au responsable', 403);
    tablesQr();
    const c = cfg();
    return {
      config: { ...c, secret: c.secret ? '••••••••' : '' }, sync: { ok: etatSync.ok, erreur: etatSync.erreur, essai: etatSync.essai }, service: service(),
      tables: Object.entries(D().qrTables).map(([j, t]) => ({ jeton: j, salle: t.salle, salleNom: salleNom(t.salle), table: t.table, retire: !!t.retire, pause: !!(c.pauses || {})[j], url: URL_COMMANDE + j })),
      retoursEssais: D().retoursEssaisQr || [], suiviSuggestions: D().suiviSuggestionsQr || [],
      historique: D().qrInbox.slice(-60).reverse().map(x => ({ id: x.id, type: x.type, salle: x.salle ? salleNom(x.salle) : '?', table: x.table, recu: x.recu, statut: x.statut, montant: x.montantAccepte || x.montant || 0, par: x.decision ? x.decision.par : '', motif: x.motif || '', alertes: x.alertes || [] })),
    };
  };
  R['POST /api/qr/reglages'] = (b, u) => {
    if (!peut(u, 'admin')) E('Réservé au responsable', 403);
    const c = cfg();
    const h = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));
    if (b.relais !== undefined) { const r = String(b.relais || '').trim(); if (r && !/^https:\/\//.test(r) && !/^http:\/\/(localhost|127\.)/.test(r)) E('L’adresse du relais doit commencer par https://'); c.relais = r; }
    if (b.secret !== undefined && !/^•+$/.test(b.secret)) c.secret = String(b.secret || '').trim();
    if (b.actif !== undefined) c.actif = !!b.actif;
    if (b.son !== undefined) c.son = !!b.son;
    if (typeof b.essais === 'boolean') c.essais = b.essais;
    if (b.suites !== undefined) c.suites = b.suites === 'normal' ? 'normal' : 'direct';
    if (b.montantMax !== undefined) c.montantMax = Math.max(1000, Math.round(+b.montantMax || 40000));
    for (const k of ['ouverture', 'ouvertureVendredi', 'derniereCommande']) if (b[k] !== undefined) { if (!h(b[k])) E('Heure invalide : ' + b[k]); c[k] = b[k]; }
    if (b.horaires && typeof b.horaires === 'object') { const o = {}; for (const [k, v] of Object.entries(b.horaires)) { if (!Array.isArray(v) || !h(v[0]) || !h(v[1])) E('Horaire invalide pour ' + k); o[String(k).slice(0, 30)] = [v[0], v[1]]; } c.horaires = o; }
    etatSync.carteHash = ''; // renvoyer la carte et les horaires
    journal(u, 'réglages QR', Object.keys(b).filter(k => k !== 'secret').join(', ') + (b.secret && !/^•+$/.test(b.secret) ? ', clé' : ''));
    save(); if (c.actif) setTimeout(sync, 100);
    return { ok: true };
  };
  // imprime sur l'imprimante des tickets un QR par table (à plastifier), pour une salle ou une table précise
  R['POST /api/qr/imprimer'] = async (b, u) => {
    if (!peut(u, 'admin')) E('Réservé au responsable', 403);
    tablesQr();
    const liste = Object.entries(D().qrTables).filter(([, t]) => !t.retire && (!b.salle || t.salle === b.salle) && (!b.table || t.table === String(b.table)));
    if (!liste.length) E('Aucune table');
    const erreurs = [];
    for (const [j, t] of liste) {
      const d = new K.Doc();
      d.center(1).bold(1).size(2).t('LA MAISON BLANCHE').size(0).bold(0);
      d.t('Commandez depuis votre table').t('');
      d.qr(URL_COMMANDE + j, 8).t('');
      d.size(2).bold(1).t('TABLE ' + t.table).size(0).bold(0).t(salleNom(t.salle).toUpperCase());
      d.t('').t('Scannez avec l’appareil photo').t('de votre téléphone').center(0);
      d.cut();
      const r = await K.imprimer('ticket', d); if (!r.ok) { erreurs.push(r.erreur); break; }
    }
    return { ok: true, erreurs, nb: liste.length };
  };

  init();
  setInterval(() => { sync().catch(() => {}); }, 3000);
  setInterval(() => { try { tablesQr(); } catch (e) {} }, 60000);
  // 3.8.0 : état réel du relais pour Gestion → Diagnostic
  function diag() { return { derniereSynchro: etatSync.ok || null, dernierEssai: etatSync.essai || null, erreur: etatSync.erreur || '', enLigne: now() - etatSync.ok < 20000, attente: D().qrInbox.filter(x => x.statut === 'attente').length }; }
  return { etat, sync, service, carte, tablesQr, recevoir, estEssai, diag, _etatSync: etatSync };
};
