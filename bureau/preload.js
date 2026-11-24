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
  // Période et filtres affichés à l'écran (lus dans la page, sans toucher à son code)
  const AXES = { 'Regrouper par': 'grouper', Article: 'article', Famille: 'famille', Vendeur: 'vendeur', Salle: 'salle', Origine: 'origine', Statut: 'statut', 'Heure de saisie': 'heure', Jour: 'date' };
  const parametres = () => {
    const p = {};
    const f = document.getElementById('periode');
    if (f) { p.du = f.elements.du.value; p.au = f.elements.au.value; }
    for (const label of document.querySelectorAll('#filtres label')) {
      const cle = AXES[(label.firstChild?.textContent || '').trim()], champ = label.querySelector('select');
      if (cle && champ && champ.value) p[cle] = champ.value;
    }
    return p;
  };
  ipcRenderer.on('parametres-export', (e, format) => ipcRenderer.send('exporter', format, parametres()));
  // Le bouton d'export de la page produit un PDF (le CSV reste dans le menu Rapports)
  window.addEventListener('DOMContentLoaded', () => {
    const b = document.getElementById('export');
    if (b) b.textContent = 'Exporter en PDF';
  });
  document.addEventListener('click', e => {
    if (e.target && e.target.id === 'export') {
      e.preventDefault(); e.stopImmediatePropagation();
      ipcRenderer.send('exporter', 'pdf', parametres());
    }
  }, true);
}
