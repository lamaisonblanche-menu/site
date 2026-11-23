'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const maj=require('../maj');
test('Windows: ordre des versions, refus des versions mauvaises et retour à l embarquée',()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'mb-maj-'));
 try{
  const cores=path.join(tmp,'cores'),emb=path.join(tmp,'embarque');
  fs.mkdirSync(cores);fs.mkdirSync(emb);
  fs.writeFileSync(path.join(emb,'VERSION'),'3.5.3\n');
  assert.equal(maj.cmp('3.5.4','3.5.3'),1);
  assert.equal(maj.cmp('3.5.3','3.5.4'),-1);
  assert.equal(maj.cmp('3.5.4','3.5.4'),0);
  const d=path.join(cores,'3.5.4');fs.mkdirSync(d);
  fs.writeFileSync(path.join(d,'VERSION'),'3.5.4\n');
  assert.equal(maj.coreAUtiliser(cores,emb).version,'3.5.3','Version incomplète refusée');
  fs.writeFileSync(path.join(d,'.complet'),'ok');
  assert.equal(maj.coreAUtiliser(cores,emb).version,'3.5.4','Version complète sélectionnée');
  maj.marquerMauvaise(cores,'3.5.4');
  assert.equal(maj.coreAUtiliser(cores,emb).version,'3.5.3','Retour version embarquée');
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
test('Windows: syntaxe et modules de mise à jour présents',()=>{
 const main=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');
 assert.match(main,/async function verifierMaj/);
 assert.match(main,/async function installerMaj/);
 assert.match(main,/redemarrageVoulu/);
 assert.match(fs.readFileSync(path.join(__dirname,'../maj.js'),'utf8'),/Fichier abîmé pendant le téléchargement/);
});
