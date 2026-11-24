'use strict';
const zone = document.getElementById('contenu');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nomCaisse = c => c ? esc(c.nom ? c.nom + ' (' + c.adresse + ')' : c.adresse) : 'la caisse principale';
const heure = ts => new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const CHEMIN = '<span class="chemin">Gestion → Réglages → Rapports du bureau</span>';
const boutons = (...b) => '<div class="actions">' + b.join('') + '</div>';
const B = (id, texte, principal) => `<button id="${id}" class="${principal ? 'principal' : ''}">${texte}</button>`;

const ECRANS = {
  connexion: e => `<h2>Connexion à la caisse…</h2><div class="roue"></div><p class="note">Caisse associée : ${nomCaisse(e.caisse)}</p>`,
  recherche: () => `<h2>Recherche de la caisse principale…</h2><div class="roue"></div><p class="note">Ce PC cherche la caisse sur le réseau du restaurant. Cela prend quelques secondes.</p>`,
  code: e => `<h2>Dernière étape : accepter ce PC sur la caisse</h2>
    <p>Caisse trouvée : <b>${nomCaisse(e.caisse)}</b>. Code de ce PC :</p>
    <div class="code" id="code">${esc(e.code.slice(0, 3) + ' ' + e.code.slice(3))}</div>
    <ol><li>Sur la <b>caisse principale</b>, connectez-vous avec le code du responsable.</li>
    <li>Ouvrez ${CHEMIN}.</li>
    <li>Vérifiez que le code affiché est <b>le même</b>, puis appuyez sur <b>Accepter</b>.</li></ol>
    <p class="note">Les rapports s’ouvriront tout seuls ici. Ce PC pourra seulement consulter les ventes : il n’aura aucun droit sur la caisse.</p>
    ${e.horsLigne ? '<p class="alerte">La caisse ne répond plus. Nouvel essai automatique…</p>' : ''}
    ${boutons(B('manuel', 'Saisir la clé à la main'))}`,
  manuel: e => `<h2>${e.raison === 'ancienne' ? 'Caisse trouvée : recopiez sa clé' : 'Association manuelle'}</h2>
    ${e.raison === 'ancienne' ? `<p>La caisse (${nomCaisse(e.caisse)}) n’a pas encore l’association par code. Recopiez sa clé une seule fois :</p>` : e.message ? `<p class="alerte">${esc(e.message)}</p>` : ''}
    <ol><li>Sur la caisse principale, ouvrez ${CHEMIN}.</li><li>Recopiez la <b>clé de consultation</b> ci-dessous (64 caractères).</li></ol>
    <form id="formulaire"><label for="adresse">Adresse de la caisse</label><input id="adresse" value="${esc(e.caisse ? e.caisse.adresse + (e.caisse.port && e.caisse.port !== 8080 ? ':' + e.caisse.port : '') : '')}" placeholder="ex. 192.168.1.20" autocomplete="off">
    <label for="cle">Clé de consultation</label><input id="cle" autocomplete="off" spellcheck="false" placeholder="64 caractères">
    <p id="erreur" class="alerte" hidden></p>
    ${boutons(B('valider', 'Associer ce PC', true), B('reessayer', 'Relancer la recherche'))}</form>`,
  introuvable: e => `<h2>Caisse principale introuvable</h2>
    <p class="alerte">Ce PC n’a trouvé aucune caisse sur le réseau${e.reseaux?.length ? ' (' + esc(e.reseaux.join(', ')) + ')' : ''}.</p>
    <ol><li>Vérifiez que la <b>caisse principale est allumée</b> et que la caisse est ouverte à l’écran.</li>
    <li>Vérifiez que ce PC est branché sur le <b>même réseau</b> que la caisse (même box ou même Wi-Fi du restaurant).</li>
    <li>Appuyez sur <b>Relancer la recherche</b>.</li></ol>
    ${boutons(B('reessayer', 'Relancer la recherche', true), B('manuel', 'Saisir l’adresse et la clé à la main'))}`,
  refuse: e => `<h2>Demande refusée</h2><p class="alerte">La caisse ${nomCaisse(e.caisse)} a refusé l’accès de ce PC.</p>
    <p>Si c’est une erreur, relancez la demande puis appuyez sur <b>Accepter</b> sur la caisse (${CHEMIN}).</p>${boutons(B('associer', 'Refaire la demande', true))}`,
  hors: e => `<h2>Caisse principale hors ligne</h2>
    <p class="alerte">La caisse ${nomCaisse(e.caisse)} ne répond pas${e.dernier ? ' depuis ' + heure(e.dernier) : ''}.</p>
    <ol><li>Vérifiez que le PC de la caisse principale est allumé et que la caisse est ouverte.</li><li>Vérifiez le câble réseau ou le Wi-Fi de ce PC.</li></ol>
    <p class="note">Nouvel essai automatique toutes les 10 secondes. Les rapports reviendront tout seuls. Si la caisse a changé d’adresse, elle sera retrouvée automatiquement.</p>
    ${boutons(B('reessayer', 'Réessayer maintenant', true))}`,
  retire: e => `<h2>Accès retiré par la direction</h2>
    <p class="alerte">La clé de consultation de ce PC a été désactivée ou renouvelée sur la caisse ${nomCaisse(e.caisse)}.</p>
    <p>Pour rétablir l’accès, refaites l’association puis acceptez-la sur la caisse (${CHEMIN}).</p>${boutons(B('associer', 'Associer à nouveau', true))}`,
  ancienne: e => `<h2>Module Rapports absent</h2><p class="alerte">La caisse ${nomCaisse(e.caisse)} n’a pas le module Rapports du bureau (version 3.7.0 ou plus récente nécessaire).</p>${boutons(B('reessayer', 'Réessayer', true))}`,
};

function rendre(e) {
  document.body.dataset.ecran = e.ecran;
  const vue = ECRANS[e.ecran];
  if (!vue) return;
  // ne pas effacer une clé en cours de saisie quand l'état est renvoyé
  if ((e.ecran === 'manuel' || e.ecran === 'code') && document.getElementById('formulaire') && zone.dataset.ecran === 'manuel') return;
  zone.dataset.ecran = e.ecran;
  zone.innerHTML = vue(e);
  const clic = (id, fn) => { const b = document.getElementById(id); if (b) b.onclick = fn; };
  clic('reessayer', ev => { ev.preventDefault(); window.bureau.reessayer(); });
  clic('associer', () => window.bureau.associer());
  clic('manuel', () => rendre({ ecran: 'manuel', caisse: e.caisse }));
  const f = document.getElementById('formulaire');
  if (f) f.onsubmit = async ev => {
    ev.preventDefault();
    const v = document.getElementById('valider'), err = document.getElementById('erreur');
    v.disabled = true; v.textContent = 'Vérification…'; err.hidden = true;
    const r = await window.bureau.manuel({ adresse: document.getElementById('adresse').value, cle: document.getElementById('cle').value });
    if (r && r.erreur) { err.textContent = r.erreur; err.hidden = false; v.disabled = false; v.textContent = 'Associer ce PC'; }
  };
}
window.bureau.surEtat(rendre);
window.bureau.etat().then(rendre);
