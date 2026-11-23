// Mises à jour automatiques du « cœur » de la caisse (écrans, calculs, impressions).
// Le cœur est téléchargé depuis GitHub, vérifié (empreinte SHA-256), puis installé
// seulement quand le restaurant est calme (aucune table ouverte).
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CANAL = process.env.CAISSE_CANAL || 'https://raw.githubusercontent.com/lamaisonblanche-menu/site/caisse/maj/';

function cmp(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}
function lireVersion(dir) { try { return fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim(); } catch (e) { return null; } }
function mauvaises(cores) { try { return JSON.parse(fs.readFileSync(path.join(cores, 'mauvaises.json'), 'utf8')); } catch (e) { return []; } }
function marquerMauvaise(cores, v) { const m = mauvaises(cores); if (!m.includes(v)) m.push(v); fs.mkdirSync(cores, { recursive: true }); fs.writeFileSync(path.join(cores, 'mauvaises.json'), JSON.stringify(m)); }

// Le cœur à lancer : le plus récent entre celui livré avec l'application et ceux téléchargés
function coreAUtiliser(cores, embarque) {
  const bad = mauvaises(cores);
  const liste = [{ dir: embarque, version: lireVersion(embarque) || '0.0.0', telecharge: false }];
  try {
    for (const d of fs.readdirSync(cores)) {
      const dir = path.join(cores, d);
      if (!fs.existsSync(path.join(dir, '.complet'))) continue;
      const v = lireVersion(dir);
      if (v && !bad.includes(v)) liste.push({ dir, version: v, telecharge: true });
    }
  } catch (e) {}
  liste.sort((a, b) => cmp(b.version, a.version));
  return liste[0];
}

function get(url, binaire, n = 0) {
  return new Promise((res, rej) => {
    const req = https.get(url, { headers: { 'User-Agent': 'caisse-maison-blanche', 'Cache-Control': 'no-cache' }, timeout: 20000 }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && n < 5) { r.resume(); return res(get(new URL(r.headers.location, url).toString(), binaire, n + 1)); }
      if (r.statusCode !== 200) { r.resume(); return rej(new Error('HTTP ' + r.statusCode + ' ' + url)); }
      const parts = []; r.on('data', c => parts.push(c)); r.on('end', () => { const b = Buffer.concat(parts); res(binaire ? b : b.toString('utf8')); });
    });
    req.on('timeout', () => req.destroy(new Error('Délai dépassé')));
    req.on('error', rej);
  });
}

// Vérifie s'il existe une version plus récente et la télécharge. Renvoie la version prête, ou null.
async function verifier(cores, versionActuelle) {
  const m = JSON.parse(await get(CANAL + 'version.json?t=' + Date.now()));
  if (!m.version || cmp(m.version, versionActuelle) <= 0) return { a_jour: true, distante: m.version, notes: m.notes || '' };
  if (mauvaises(cores).includes(m.version)) return { a_jour: true, distante: m.version, refusee: true };
  const final = path.join(cores, m.version);
  if (fs.existsSync(path.join(final, '.complet'))) return { prete: m.version, notes: m.notes || '' };
  const tmp = final + '.tmp';
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const f of m.fichiers) {
    if (f.chemin.includes('..')) throw new Error('Chemin refusé');
    const b = await get(CANAL + 'core/' + f.chemin.split('/').map(encodeURIComponent).join('/') + '?v=' + m.version, true);
    const h = crypto.createHash('sha256').update(b).digest('hex');
    if (h !== f.sha256) throw new Error('Fichier abîmé pendant le téléchargement : ' + f.chemin);
    const dest = path.join(tmp, f.chemin);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, b);
  }
  if (lireVersion(tmp) !== m.version) throw new Error('Version incohérente');
  fs.writeFileSync(path.join(tmp, '.complet'), new Date().toISOString());
  fs.rmSync(final, { recursive: true, force: true });
  fs.renameSync(tmp, final);
  nettoyer(cores, m.version);
  return { prete: m.version, notes: m.notes || '' };
}
// garde seulement les 3 dernières versions téléchargées
function nettoyer(cores, garder) {
  try {
    const v = fs.readdirSync(cores).filter(d => /^\d+\.\d+\.\d+$/.test(d)).sort(cmp).reverse();
    for (const d of v.slice(3)) if (d !== garder) fs.rmSync(path.join(cores, d), { recursive: true, force: true });
  } catch (e) {}
}

module.exports = { cmp, coreAUtiliser, verifier, marquerMauvaise, lireVersion, CANAL };
