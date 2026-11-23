// Publie le cœur de la caisse (core/) sur le canal de mises à jour (dossier maj/ de la branche « caisse »).
// Usage : node outils/publier.js "Notes de version"
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const src = path.join(__dirname, '..', 'core'), dst = path.join(__dirname, '..', '..', 'maj');
const version = fs.readFileSync(path.join(src, 'VERSION'), 'utf8').trim();
fs.rmSync(path.join(dst, 'core'), { recursive: true, force: true });
fs.cpSync(src, path.join(dst, 'core'), { recursive: true, filter: f => !/[\\/](data|node_modules)([\\/]|$)/.test(f) });
const fichiers = [];
(function tour(d, rel) { for (const f of fs.readdirSync(d).sort()) { const p = path.join(d, f), r = rel ? rel + '/' + f : f; if (fs.statSync(p).isDirectory()) tour(p, r); else fichiers.push({ chemin: r, sha256: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') }); } })(path.join(dst, 'core'), '');
fs.writeFileSync(path.join(dst, 'version.json'), JSON.stringify({ version, date: new Date().toISOString(), notes: process.argv[2] || '', fichiers }, null, 1));
console.log('Version', version, 'publiée :', fichiers.length, 'fichiers');
