const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const { verifyWithRecorderSigningKeys, equalOpaqueSecret } = require('../recorder-credential-transition');
const { createTrainingToken, verifyTrainingToken } = require('../training-token');
const { createTrainingSecurity } = require('../training-security');
const { createAdminAuth } = require('../admin-auth');

const old='synthetic-old-recorder-signing';
const fresh='synthetic-new-recorder-signing';
const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
const functions=source.slice(source.indexOf('function base64url('),source.indexOf('app.post("/webhook/ghl"'));
const resultRoute=source.slice(source.indexOf('app.get("/recording-result/:id"'),source.indexOf('function publicScorecard('));
const env=(primary=old,previous=fresh,gate='true')=>({RECORDER_TOKEN_SECRET:primary,RECORDER_PREVIOUS_TOKEN_SECRET:previous,RECORDER_CREDENTIAL_ROTATION_ENABLED:gate});
const jwt=(header,payload,secret)=>{
  const input=[header,payload].map(x=>Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');
  return input+'.'+crypto.createHmac('sha256',secret).update(input).digest('base64url');
};
function staff(secret,extra={}) {
  const now=Math.floor(Date.now()/1000);
  return jwt({alg:'HS256',typ:'AIRA-RECORDER'},{iss:'aira-api',aud:'aira-backend',sub:'fixture-staff',role:'franchisee',location_ids:['gym-a'],nbf:now-30,exp:now+900,...extra},secret);
}
function result(secret,id='fixture-recording',extra={}) {
  const now=Math.floor(Date.now()/1000);
  return jwt({alg:'HS256',typ:'AIRA-RECORDING-RESULT'},{iss:'aira-backend',aud:'aira-staff-app',sub:id,location_id:'gym-a',iat:now,exp:now+7*86400,...extra},secret);
}
const training=secret=>createTrainingToken({admin:{id:'fixture-staff',email:'fixture@example.test',role:'manager'},features:['practice'],locationIds:['gym-a'],secret}).token;

function context(configuration,app) {
  let reads=0;let apiChecks=0;
  const c={Buffer,crypto,app,process:{env:configuration},recorderLocationAliases:new Map(),
    canonicalLocationId:id=>String(id).toLowerCase().trim(),console:{warn(){},log(){},error(){}},
    verifyWithRecorderSigningKeys:(token,verify)=>verifyWithRecorderSigningKeys(token,verify,configuration),
    axios:{async get(url,{headers}){apiChecks++;if(headers.Authorization!=='Bearer fixture-supabase-session')throw new Error('Fixture refuses external verification');return {data:{role:'franchisee',location_ids:['gym-a']}};}},
    db:{async getRecording(id){reads++;if(!['fixture-recording','foreign-recording'].includes(id))return null;return {recording_id:id,location_id:id==='foreign-recording'?'gym-b':'gym-a',contact_name:'Fixture',processing_status:'uploaded'};},async getScorecardByRecording(){reads++;return null;}},
  };
  vm.createContext(c);vm.runInContext(functions,c);
  if(app)vm.runInContext(resultRoute,c);
  return {c,reads:()=>reads,apiChecks:()=>apiChecks};
}

test('staff, result and training readers require the exact gate for a secondary root',()=>{
  for(const gate of [undefined,'',false,true,'false','TRUE','1']) {
    const configuration={...env(),RECORDER_CREDENTIAL_ROTATION_ENABLED:gate};
    const {c}=context(configuration);
    for(const [token,verify] of [[staff(fresh),c.verifyStaffToken],[result(fresh),(t,k)=>c.verifyRecordingResultToken(t,'fixture-recording',k)],[training(fresh),verifyTrainingToken]]) {
      assert.throws(()=>verifyWithRecorderSigningKeys(token,verify,configuration));
    }
    assert.equal(verifyWithRecorderSigningKeys(staff(old),c.verifyStaffToken,configuration).role,'franchisee');
  }
});

test('both reader generations accept all token purposes while new issuance stays primary-only',()=>{
  for(const configuration of [env(old,fresh),env(fresh,old)]) {
    const {c}=context(configuration);
    for(const key of [old,fresh]) {
      assert.equal(verifyWithRecorderSigningKeys(staff(key),c.verifyStaffToken,configuration).role,'franchisee');
      assert.equal(verifyWithRecorderSigningKeys(result(key),(t,k)=>c.verifyRecordingResultToken(t,'fixture-recording',k),configuration).sub,'fixture-recording');
      assert.equal(verifyWithRecorderSigningKeys(training(key),verifyTrainingToken,configuration).sub,'fixture-staff');
    }
    const issued=c.signRecordingResultToken({recording_id:'fixture-recording',location_id:'gym-a'});
    assert.equal(c.verifyRecordingResultToken(issued,'fixture-recording',configuration.RECORDER_TOKEN_SECRET).sub,'fixture-recording');
    assert.throws(()=>c.verifyRecordingResultToken(issued,'fixture-recording',configuration.RECORDER_PREVIOUS_TOKEN_SECRET));
  }
});

test('retirement rejects every old purpose and a missing primary never uses the old slot',()=>{
  for(const configuration of [env(fresh,old,'false'),env('',old)]) {
    const {c}=context(configuration);
    for(const [token,verify] of [[staff(old),c.verifyStaffToken],[result(old),(t,k)=>c.verifyRecordingResultToken(t,'fixture-recording',k)],[training(old),verifyTrainingToken]]) {
      assert.throws(()=>verifyWithRecorderSigningKeys(token,verify,configuration));
    }
  }
});

test('transition preserves role, purpose, expiry, subject binding and tamper rejection',()=>{
  const configuration=env();const {c}=context(configuration);
  for(const token of [staff(fresh,{role:'member'}),staff(fresh,{exp:1}),staff(fresh,{aud:'other'}),result(fresh),'malformed']) {
    assert.throws(()=>verifyWithRecorderSigningKeys(token,c.verifyStaffToken,configuration));
  }
  for(const token of [staff(fresh),result(fresh,'another-recording'),result(fresh,'fixture-recording',{exp:1}),result('third-key')]) {
    assert.throws(()=>verifyWithRecorderSigningKeys(token,(t,k)=>c.verifyRecordingResultToken(t,'fixture-recording',k),configuration));
  }
});

test('actual result route and administrator middleware enforce retired keys and gym scope',async()=>{
  const configuration=env(fresh,old,'false');const app=express();const f=context(configuration,app);
  const middleware=createAdminAuth({env:configuration,verifyStaffToken:t=>verifyWithRecorderSigningKeys(t,f.c.verifyStaffToken,configuration),normalizeLocationId:String});
  app.get('/scorecard/:id',middleware,(req,res)=>res.sendStatus(404));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=(url,staffToken,resultToken)=>fetch(base+url,{headers:{...(staffToken?{Authorization:'Bearer '+staffToken}:{}),...(resultToken?{'x-aira-recording-result-token':resultToken}:{})}});
  try {
    assert.equal((await request('/recording-result/fixture-recording',staff(old),result(fresh))).status,401);assert.equal(f.reads(),0);
    assert.equal((await request('/recording-result/fixture-recording',staff(fresh),result(old))).status,401);assert.equal(f.reads(),0);
    assert.equal((await request('/recording-result/foreign-recording',staff(fresh),result(fresh,'foreign-recording'))).status,403);assert.equal(f.reads(),1);
    assert.equal((await request('/recording-result/fixture-recording',staff(fresh),result(fresh))).status,200);assert.equal(f.reads(),3);
    assert.equal((await request('/recording-result/missing-recording',staff(fresh),result(fresh,'missing-recording'))).status,404);
    assert.equal((await request('/recording-result/fixture-recording','fixture-supabase-session',result(fresh))).status,200);
    assert.equal((await request('/scorecard/missing',staff(old))).status,401);
    assert.equal((await request('/scorecard/missing',staff(fresh))).status,404);
    assert.equal((await request('/scorecard/missing')).status,401);
  } finally {await new Promise(r=>server.close(r));}
});

test('training page authentication uses staged keys without any quota or paid action',async()=>{
  const configuration=env();let reservations=0;
  const guard=createTrainingSecurity({secret:()=>configuration.RECORDER_TOKEN_SECRET,previousSecret:()=>configuration.RECORDER_PREVIOUS_TOKEN_SECRET,
    rotationEnabled:()=>configuration.RECORDER_CREDENTIAL_ROTATION_ENABLED,getSession:()=>null,canonicalLocationId:String,getPlayerById:async()=>null,
    reserveUsage:async()=>{reservations++;throw new Error('Fixture refuses quota work');}});
  const app=express();app.use('/practice',guard.auth);app.get('/practice',(req,res)=>res.send('Fixture'));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url=`http://127.0.0.1:${server.address().port}/practice`;
  const request=key=>fetch(url,{headers:{Authorization:'Bearer '+training(key)}});
  try {
    assert.equal((await request(old)).status,200);assert.equal((await request(fresh)).status,200);
    Object.assign(configuration,env(fresh,old,'false'));
    assert.equal((await request(old)).status,401);assert.equal((await request(fresh)).status,200);assert.equal(reservations,0);
  }finally{await new Promise(r=>server.close(r));}
});

test('opaque administrator comparison rejects missing, malformed and altered keys',()=>{
  assert.equal(equalOpaqueSecret('synthetic-admin-key','synthetic-admin-key'),true);
  for(const value of [undefined,null,'',{},['synthetic-admin-key'],'synthetic-admin-key!'])assert.equal(equalOpaqueSecret(value,'synthetic-admin-key'),false);
  assert.equal(equalOpaqueSecret('synthetic-admin-key',undefined),false);
});
