'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../core/public/app.js'), 'utf8').split('(async function start()')[0];

function ecran(hostname = '192.168.1.10') {
  const element = { addEventListener() {} };
  const contexte = vm.createContext({
    location: { hostname }, window: { addEventListener() {} },
    document: { addEventListener() {}, querySelector: () => element },
    localStorage: { getItem: () => null, removeItem() {} },
    setInterval() {}, crypto: require('node:crypto').webcrypto,
  });
  vm.runInContext(source, contexte);
  return code => vm.runInContext(code, contexte);
}

function connecter(evaluer, role = 'serveur') {
  evaluer(`render = () => {}; refresh = () => {}; toast = () => {}; api = async () => {};
    S.token = 'session'; S.view = 'commande'; S.cmdId = 'T1';
    S.etat = { user: { id: 'u1', role: '${role}' }, config: { deconnexionServeurSec: 0 }, commandes: [{ id: 'T1' }] };
    S.draft = [{ pid: 'plat', qte: 1 }];`);
}

test('Le poste de salle verrouille après 30 secondes et rend le brouillon à son auteur', () => {
  const evaluer = ecran();
  connecter(evaluer);
  evaluer('lastTouch = Date.now() - 31000; verifierInactivite()');
  assert.equal(evaluer('S.view'), 'login');
  assert.equal(evaluer('S.token'), '');
  connecter(evaluer);
  evaluer("S.etat.user.id = 'u2'; A.voir('T1')");
  assert.equal(evaluer('S.draft.length'), 0);
  evaluer("S.etat.user.id = 'u1'; A.voir('T1')");
  assert.equal(evaluer('S.draft.length'), 1);
});

test('La caisse principale garde sa session pendant la prise de commande', () => {
  const evaluer = ecran('127.0.0.1');
  connecter(evaluer);
  evaluer('lastTouch = Date.now() - 31000; verifierInactivite()');
  assert.equal(evaluer('S.view'), 'commande');
});

test('Envoyer quitte la table pour tous les rôles si le bon est accepté, et reste sur place en cas d’erreur', async () => {
  for (const role of ['serveur', 'caissier']) {
    const evaluer = ecran();
    connecter(evaluer, role);
    await evaluer("api = async () => ({ erreurs: ['Imprimante indisponible'] }); A.envoyer()");
    assert.equal(evaluer('S.view'), 'commande');
    assert.equal(evaluer('S.draft.length'), 0);
    await evaluer("S.draft = [{ pid: 'menu', qte: 1 }]; api = async () => ({ erreurs: [] }); A.envoyer()");
    assert.equal(evaluer('S.view'), 'tables');
  }
});
