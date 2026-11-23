'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../core/server.js'), 'utf8');
test('CSV : les champs dangereux et les séparateurs sont échappés', () => {
  const a = source.indexOf('function csv(rows)'), b = source.indexOf('\n\nconst MIME', a);
  assert.ok(a >= 0 && b > a);
  const csv = vm.runInNewContext(source.slice(a, b) + '\ncsv');
  const out = csv([['=1+1', '+2', '-3', '@A', 'a;b', 'a"b'], ['ok', 'ligne\nsuivante']]);
  for (const v of ["'=1+1", "'+2", "'-3", "'@A", '"a;b"', '"a""b"', '"ligne\nsuivante"']) assert.ok(out.includes(v), v);
});
test('Les protections critiques restent présentes', () => {
  for (const s of ['SESSION_IDLE_MS', 'controleEssais(req)', 'Option sélectionnée plusieurs fois', 'Montant de paiement invalide', 'Quantité invalide (1 à 99)']) assert.ok(source.includes(s), s);
});
