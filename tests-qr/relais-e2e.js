const {spawn}=require('child_process'),fs=require('fs');
const DATA='/tmp/qrrel';fs.rmSync(DATA,{recursive:true,force:true});
const PORT=18310,REL='http://127.0.0.1:18299',ORI='http://localhost:18300';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const ok=(c,m)=>{console.log((c?'  OK  ':'  ÉCHEC ')+m);if(!c)process.exitCode=1;};
const api=async(p,b,t)=>{const r=await fetch('http://localhost:'+PORT+p,{method:b?'POST':'GET',headers:{'Content-Type':'application/json','X-Token':t||''},body:b?JSON.stringify(b):undefined});const j=await r.json();if(!r.ok)throw new Error(j.erreur);return j;};
const tel=async(p,b)=>{const r=await fetch(REL+p,{method:b?'POST':'GET',headers:{'Content-Type':'application/json',Origin:ORI},body:b?JSON.stringify(b):undefined});return {st:r.status,cors:r.headers.get('access-control-allow-origin'),j:await r.json().catch(()=>null)};};
(async()=>{
  const srv=spawn('node',[require('path').join(__dirname, '..', 'app/core/server.js')],{env:{...process.env,CAISSE_DATA:DATA,PORT}});
  await wait(1500);
  const adm=(await api('/api/login',{pin:'1234'})).token, s=(await api('/api/login',{pin:'2000'})).token;
  let r=await fetch(REL+'/caisse/sync',{method:'POST',headers:{Authorization:'Bearer faux'},body:'{}'});ok(r.status===401,'mauvaise clé refusée');
  await api('/api/qr/reglages',{actif:true,relais:REL,secret:'test-secret',ouverture:'00:00',ouvertureVendredi:'00:00',derniereCommande:'23:59',horaires:{Brunch:['00:00','23:59'],Asiatique:['00:00','23:59']}},adm);
  await wait(4000);
  const Q=await api('/api/qr/admin',null,adm);const j=Q.tables.find(t=>t.salle==='brunch'&&t.table==='25').jeton;
  let t=await tel('/api/table?t='+j);ok(t.st===200&&t.j.table==='25'&&t.j.caisseEnLigne,'téléphone : table reconnue, caisse en ligne');ok(t.cors===ORI,'CORS limité à l’origine autorisée');
  ok((await tel('/api/table?t=xxxx')).st===404,'QR inconnu refusé');
  const c=(await tel('/api/carte')).j;ok(c&&c.produits.length>50,'téléphone : carte ('+c.produits.length+' articles)');
  const P=n=>c.produits.find(p=>new RegExp(n,'i').test(p.nom));
  const cmd={t:j,sid:'sid-test-0001',type:'commande',appareil:'app-1',lignes:[{pid:P('Entrecôte').id,qte:1,opts:[{g:'cuisson',i:1}]},{pid:P('Pavlova').id,qte:1}],note:'test'};
  const a=await tel('/api/commande',cmd), b=await tel('/api/commande',cmd);
  ok(a.st===200&&b.j.id===a.j.id,'double envoi (même sid) : une seule commande '+a.j.id);
  const x=await tel('/api/commande',{...cmd,sid:'sid-test-0002'});ok(x.st===429,'2e commande dans les 20 s refusée (anti-abus)');
  ok((await tel('/api/commande',{...cmd,sid:'sid-test-0003',lignes:[{pid:'nexistepas',qte:1}]})).st===409,'article inconnu refusé');
  await wait(4500);
  let e=await api('/api/etat',null,s);const it=e.qr.attente.find(q=>q.id===a.j.id);ok(it&&it.table==='25','caisse : commande reçue via le relais');
  let st=await tel('/api/commande?id='+a.j.id+'&a=app-1');ok(st.j.statut==='recue','téléphone : statut « reçue »');
  ok((await tel('/api/commande?id='+a.j.id+'&a=autre')).st===404,'statut caché à un autre téléphone');
  await api('/api/qr/accepter',{id:a.j.id},s);await wait(4500);
  st=await tel('/api/commande?id='+a.j.id+'&a=app-1');ok(st.j.statut==='acceptee'&&st.j.total>0,'téléphone : statut « acceptée », total '+st.j.total);
  e=await api('/api/etat',null,s);ok(e.qr.attente.filter(q=>q.id===a.j.id).length===0,'plus en attente après acceptation');
  // addition
  const ad=await tel('/api/commande',{t:j,sid:'sid-test-0010',type:'addition',appareil:'app-1'});ok(ad.st===200,'demande d’addition acceptée par le relais');
  // pause
  await api('/api/qr/pause',{jeton:j,pause:true},adm);await wait(4000);
  ok((await tel('/api/commande',{...cmd,sid:'sid-test-0020'})).st===409,'table en pause : commande refusée');
  // caisse arrêtée
  srv.kill();await wait(1000);
  console.log('  (caisse arrêtée : il faudrait 120 s pour que le relais la considère hors ligne — vérifié par lecture du code)');
  process.exit();
})().catch(e=>{console.error(e);process.exit(1)});
