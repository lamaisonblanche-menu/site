// Pont entre les écrans de la caisse et l'application Windows
const { contextBridge, ipcRenderer } = require('electron');
const appel = (n) => (...a) => ipcRenderer.invoke(n, ...a);
contextBridge.exposeInMainWorld('caisseApp', {
  info: appel('info'), decouvrir: appel('decouvrir'), tester: appel('tester'), choisir: appel('choisir'),
  reglages: appel('reglages'), quitter: appel('quitter'), dossier: appel('dossier'), journal: appel('journal'),
});
