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

test('Caisse principale : un serveur est déconnecté, un caissier garde sa session mais sort de la table (brouillon gardé)', () => {
  const evaluer = ecran('127.0.0.1');
  connecter(evaluer, 'serveur');
  evaluer('lastTouch = Date.now() - 31000; verifierInactivite()');
  assert.equal(evaluer('S.view'), 'login');
  const ev2 = ecran('127.0.0.1');
  connecter(ev2, 'caissier');
  ev2("document.querySelector = () => ({ hidden: true, addEventListener() {} })");
  ev2('lastTouch = Date.now() - 31000; verifierInactivite()');
  assert.equal(ev2('S.view'), 'tables');
  assert.equal(ev2('S.token'), 'session');
  ev2("A.voir('T1')");
  assert.equal(ev2('S.draft.length'), 1);
});

test('Écran de salle : un caissier ou le responsable est aussi déconnecté après 30 s, même si le réglage dit 0', () => {
  for (const role of ['caissier', 'admin']) {
    const evaluer = ecran();
    connecter(evaluer, role);
    evaluer('lastTouch = Date.now() - 31000; verifierInactivite()');
    assert.equal(evaluer('S.view'), 'login');
  }
  const evaluer = ecran();
  connecter(evaluer);
  evaluer('lastTouch = Date.now() - 20000; verifierInactivite()');
  assert.equal(evaluer('S.view'), 'commande');
});

test('Envoyer quitte toujours la table pour tous les rôles, même si une imprimante ne répond pas', async () => {
  for (const role of ['serveur', 'caissier']) {
    const evaluer = ecran();
    connecter(evaluer, role);
    evaluer('modal = () => {}');
    await evaluer("api = async () => ({ erreurs: ['Imprimante indisponible'] }); A.envoyer()");
    assert.equal(evaluer('S.view'), 'tables');
    assert.equal(evaluer('S.draft.length'), 0);
    connecter(evaluer, role);
    await evaluer("api = async () => ({ erreurs: [] }); A.envoyer()");
    assert.equal(evaluer('S.view'), 'tables');
    connecter(evaluer, role);
    await evaluer("api = async () => { throw new Error('réseau'); }; A.envoyer()");
    assert.equal(evaluer('S.view'), 'commande', 'sans réponse de la caisse, on reste sur la table avec les articles');
    assert.equal(evaluer('S.draft.length'), 1);
  }
});
