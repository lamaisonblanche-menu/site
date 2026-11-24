// Pont minimal : l'écran local reçoit l'état ; la page des rapports de la caisse reçoit seulement sa clé de lecture.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('bureau', {
    etat: () => ipcRenderer.invoke('etat'),
    surEtat: fn => ipcRenderer.on('etat', (e, x) => fn(x)),
    reessayer: () => ipcRenderer.invoke('reessayer'),
    associer: () => ipcRenderer.invoke('associer'),
    manuel: x => ipcRenderer.invoke('manuel', x),
    journal: () => ipcRenderer.invoke('ouvrirJournal'),
  });
} else {
  // même mécanisme que la connexion manuelle de la page /suivi/ (clé gardée le temps de la session)
  try { const cle = ipcRenderer.sendSync('cle-rapports'); if (cle) sessionStorage.setItem('suivi-cle', cle); else sessionStorage.removeItem('suivi-cle'); } catch (e) {}
}
