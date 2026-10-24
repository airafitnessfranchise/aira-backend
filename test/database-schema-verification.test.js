const test = require('node:test');
const assert = require('node:assert/strict');
const contract = require('../security/recorder-database-schema-contract.json');
const { initializeRecorderDatabase, assertRecorderCatalog, RIGHTS, ALL_RIGHTS } = require('../database-schema-verification');
const user = 'aira_recorder_app_20261023';
const clone = value => JSON.parse(JSON.stringify(value));
function catalog() {
  return {
    user, role: { superuser:false,create_role:false,create_db:false,bypass_rls:false,replication:false,memberships:0 },
    schema_create:false,database_create:false,public_definers:0,extra_table_access:0,
    tables:contract.tables.map(t => ({...clone(t),rls:true,browser_access:false,own_policy:1,applicable_policies:1,
      rights:Object.fromEntries(ALL_RIGHTS.map(p => [p,RIGHTS[t.name].includes(p)]))})),
  };
}
test('default and explicit bootstrap preserve the existing initializer without catalog SQL', async () => {
  for (const env of [{},{RECORDER_DATABASE_SCHEMA_MODE:'bootstrap'}]) {
    let calls=0;
    await initializeRecorderDatabase({env,pool:{query(){assert.fail('unexpected query');}},bootstrap:async()=>{calls++;}});
    assert.equal(calls,1);
  }
});
test('verify mode queries catalogs once, binds table/privilege parameters, and never bootstraps', async () => {
  let calls=0;
  await initializeRecorderDatabase({env:{RECORDER_DATABASE_SCHEMA_MODE:'verify',RECORDER_DATABASE_EXPECTED_USER:user},
    pool:{async query(sql,args){calls++;assert.match(sql,/^SELECT /);assert.deepEqual(args,[Object.keys(RIGHTS),ALL_RIGHTS]);return {rows:[{catalog:catalog()}]};}},
    bootstrap(){assert.fail('DDL fallback');}});
  assert.equal(calls,1);
});
test('unknown mode or missing/invalid expected user fails before touching the database', async () => {
  for (const env of [{RECORDER_DATABASE_SCHEMA_MODE:'false'},{RECORDER_DATABASE_SCHEMA_MODE:'verify'},
    {RECORDER_DATABASE_SCHEMA_MODE:'verify',RECORDER_DATABASE_EXPECTED_USER:'postgres'}]) {
    await assert.rejects(initializeRecorderDatabase({env,pool:{query(){assert.fail('query');}},bootstrap(){assert.fail('bootstrap');}}),
      {code:'RECORDER_DATABASE_SCHEMA_UNVERIFIED'});
  }
});
test('provider/query failures are redacted and do not fall back to DDL', async () => {
  await assert.rejects(initializeRecorderDatabase({env:{RECORDER_DATABASE_SCHEMA_MODE:'verify',RECORDER_DATABASE_EXPECTED_USER:user},
    pool:{async query(){throw new Error('sensitive connection detail');}},bootstrap(){assert.fail('fallback');}}),
    e=>e.code==='RECORDER_DATABASE_SCHEMA_UNVERIFIED'&&!e.message.includes('sensitive'));
});
test('missing schema, unsafe role, policy and privilege drift fail closed', () => {
  const mutations=[
    c=>{c.user='postgres';},c=>{c.role.bypass_rls=true;},c=>{c.role.create_role=true;},
    c=>{c.role.memberships=1;},c=>{c.role.memberships=null;},c=>{c.schema_create=true;},c=>{c.database_create=true;},
    c=>{c.public_definers=1;},c=>{c.public_definers=null;},c=>{c.extra_table_access=1;},c=>{c.extra_table_access=null;},c=>{c.tables.pop();},
    c=>{c.tables[0].rls=false;},c=>{c.tables[0].browser_access=true;},
    c=>{c.tables[0].own_policy=0;},c=>{c.tables[0].applicable_policies=2;},
    c=>{c.tables[0].columns.pop();},c=>{c.tables[0].columns[0].type='integer';},
    c=>{c.tables[0].columns[0].not_null=!c.tables[0].columns[0].not_null;},
    c=>{c.tables[0].constraints=[];},c=>{c.tables[0].rights.TRUNCATE=true;},
    c=>{c.tables[0].rights.SELECT=false;},
  ];
  assertRecorderCatalog(catalog(),user);
  for (const change of mutations) {const bad=catalog();change(bad);assert.throws(()=>assertRecorderCatalog(bad,user),{code:'RECORDER_DATABASE_SCHEMA_UNVERIFIED'});}
});
