// Synthetic PostgreSQL lab only. The caller supplies an isolated local server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const { Pool } = require('pg');
const { RIGHTS, ALL_RIGHTS } = require('../database-schema-verification');
const base='postgresql://postgres@127.0.0.1:5432/postgres';
const user='aira_recorder_app_20261023';
const pools=[];let checks=0;
function loadDb(url) {
  process.env.DATABASE_URL=url;
  const file=path.resolve(__dirname,'../db.js');const localRequire=createRequire(file);
  const context={module:{exports:{}},exports:{},console,process,
    require(name){if(name==='pg')return {Pool:class {constructor(options){const pool=new Pool({...options,ssl:false});pools.push(pool);return pool;}}};return localRequire(name);}};
  vm.runInNewContext(fs.readFileSync(file,'utf8'),context,{filename:file});
  return context.module.exports;
}
async function denied(pool,sql) {
  await assert.rejects(pool.query(sql),e=>e.code==='42501');checks++;
}
async function main() {
  assert.equal(process.env.RECORDER_SYNTHETIC_DB_LAB,'true');
  assert(!process.env.DATABASE_URL && !process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY);
  const nonce=process.env.RECORDER_SYNTHETIC_DB_LAB_NONCE;
  assert.match(nonce || '',/^[a-f0-9]{32}$/);
  const admin=new Pool({connectionString:base});pools.push(admin);
  // The isolated container must be started with this fresh server-side marker.
  // A localhost tunnel or an operator's ordinary local database cannot pass it.
  const marker=await admin.query("SELECT current_setting('aira.recorder_lab_nonce',true) AS nonce");
  assert.equal(marker.rows[0].nonce,nonce);
  const version=await admin.query('SHOW server_version');assert.match(version.rows[0].server_version,/^17\./);
  await admin.query('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; REVOKE CREATE ON SCHEMA public FROM PUBLIC;');
  const old=loadDb(base);delete process.env.RECORDER_DATABASE_SCHEMA_MODE;await old.initDb();checks++;
  for(const table of Object.keys(RIGHTS))await admin.query(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY; REVOKE ALL ON public.${table} FROM PUBLIC, anon, authenticated;`);
  await admin.query(fs.readFileSync(path.resolve(__dirname,'../supabase/migrations/20261024004513_recorder_database_application_role.sql'),'utf8'));
  const before=await admin.query('SELECT rolcanlogin FROM pg_roles WHERE rolname=$1',[user]);assert.equal(before.rows[0].rolcanlogin,false);checks++;
  // Fixture-only local activation; no production password or connection is used.
  await admin.query(`ALTER ROLE ${user} LOGIN PASSWORD 'synthetic-lab-only';`);
  process.env.RECORDER_DATABASE_SCHEMA_MODE='verify';process.env.RECORDER_DATABASE_EXPECTED_USER=user;
  const app=loadDb(`postgresql://${user}@127.0.0.1:5432/postgres`);await app.initDb();checks++;
  const appPool=pools.at(-1);
  const fixture={recordings:"recording_id",scorecards:"scorecard_id,recording_id",practice_sessions:"session_id",players:"player_id,email",custom_locations:"location_id,franchise_name,franchisee_email"};
  for(const [table,columns] of Object.entries(fixture)) {
    const values=columns.split(',').map((c,i)=>c==='recording_id'?"'fixture'":`'fixture${i||''}'`).join(',');
    await appPool.query(`INSERT INTO public.${table} (${columns}) VALUES (${values})`);checks++;
    const count=await appPool.query(`SELECT count(*)::int AS n FROM public.${table}`);assert.equal(count.rows[0].n,1);checks++;
    if(RIGHTS[table].includes('UPDATE')){await appPool.query(`UPDATE public.${table} SET ${columns.split(',')[0]}=${columns.split(',')[0]}`);checks++;}
    else await denied(appPool,`UPDATE public.${table} SET ${columns.split(',')[0]}=${columns.split(',')[0]}`);
    if(RIGHTS[table].includes('DELETE')){await appPool.query(`DELETE FROM public.${table}`);checks++;}
    else await denied(appPool,`DELETE FROM public.${table}`);
    await denied(appPool,`TRUNCATE public.${table}`);
  }
  await denied(appPool,'CREATE TABLE public.not_allowed(id integer)');
  await denied(appPool,'ALTER TABLE public.recordings ADD COLUMN not_allowed integer');
  await denied(appPool,'CREATE ROLE not_allowed');
  await denied(appPool,'SET ROLE postgres');
  for(const browser of ['anon','authenticated']) {
    const client=await admin.connect();
    try{await client.query(`SET ROLE ${browser}`);for(const table of Object.keys(RIGHTS))await denied(client,`SELECT * FROM public.${table}`);}
    finally{await client.query('RESET ROLE');client.release();}
  }
  await admin.query(`GRANT TRUNCATE ON public.recordings TO ${user}`);
  await assert.rejects(app.initDb(),{code:'RECORDER_DATABASE_SCHEMA_UNVERIFIED'});checks++;
  await admin.query(`REVOKE TRUNCATE ON public.recordings FROM ${user}`);await app.initDb();checks++;
  process.stdout.write(JSON.stringify({synthetic:true,postgres_major:17,checks,limited_role_and_actual_startup_verified:true,
    production_connections:0,external_network:false,browser_denials:10})+'\n');
}
main().then(async()=>{await Promise.all(pools.map(p=>p.end()));}).catch(async()=>{
  process.stderr.write('Synthetic recorder database role verification failed; raw database error withheld\n');
  await Promise.allSettled(pools.map(p=>p.end()));process.exitCode=1;
});
