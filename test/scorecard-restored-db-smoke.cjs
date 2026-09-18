// Explicit lab-only smoke: runs the real db.js queries through psql in a
// network-isolated Docker database. No server, email, AI, or recording upload.
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const container = process.env.AIRA_SCORECARD_LAB_CONTAINER;
assert.match(container || '', /^aira-scorecard-security-lab-/);
const state = JSON.parse(execFileSync('docker', ['inspect', container]))[0];
assert.equal(state.HostConfig.NetworkMode, 'none');
assert.ok(!Object.keys(state.HostConfig.PortBindings || {}).length);
function literal(value) {
  if (value == null) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') { assert.ok(Number.isFinite(value)); return String(value); }
  return "'" + String(value).replaceAll("'", "''") + "'";
}
let queries = 0;
class LabPool {
  async query(statement, values = []) {
    queries++;
    let sql = statement.replace(/\$(\d+)/g, (_, n) => literal(values[Number(n)-1])).trim().replace(/;$/, '');
    const isSelect = /^SELECT\b/i.test(sql);
    const returning = /\bRETURNING\b/i.test(sql);
    const isWrite = /^(INSERT|UPDATE|DELETE)\b/i.test(sql);
    if (isSelect) sql = 'SELECT coalesce(json_agg(x),\'[]\') FROM (' + sql + ') x';
    else if (isWrite) sql = 'WITH x AS (' + sql + (returning ? '' : ' RETURNING 1') + ') SELECT coalesce(json_agg(x),\'[]\') FROM x';
    const output = execFileSync('docker', ['exec','-i',container,'psql','-X','-qAt','-h','/tmp','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],
      { input: sql + ';', encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
    const rows = isSelect || isWrite ? JSON.parse(output.trim()) : [];
    return { rows, rowCount: rows.length };
  }
}
const sandbox = { module: { exports: {} }, process: { env: {} }, console: { log() {} }, require(name) {
  if (name === 'pg') return { Pool: LabPool };
  if (name === 'uuid') return { v4: randomUUID };
  throw new Error('Unexpected dependency in isolated DB smoke');
}};
vm.runInNewContext(readFileSync(path.join(__dirname,'../db.js'),'utf8'), sandbox);
const db = sandbox.module.exports;
(async () => {
  await db.initDb(); // Proves normal startup does not reopen permissions.
  const loc = { location_id: 'synthetic-security-lab', franchise_name: 'Synthetic lab', franchisee_email: 'lab@example.invalid' };
  await db.addCustomLocation(loc);
  assert.ok((await db.getCustomLocations()).some(x => x.location_id === loc.location_id));
  await db.addCustomLocation({ ...loc, franchise_name: 'Synthetic lab updated' });
  assert.equal((await db.getCustomLocations()).find(x => x.location_id === loc.location_id).franchise_name, 'Synthetic lab updated');
  const rec = await db.createRecording({ appointment_id: 'synthetic-appointment', location_id: loc.location_id, contact_name: 'Synthetic person', duration_seconds: 30 });
  assert.equal(rec.location_id, loc.location_id);
  assert.equal((await db.findRecordingByApptId('synthetic-appointment')).recording_id, rec.recording_id);
  const updated = await db.updateRecording(rec.recording_id, { processing_status: 'scored', transcript: 'Synthetic transcript only' });
  assert.equal(updated.processing_status, 'scored');
  const score = await db.createScorecard({ recording_id: rec.recording_id, scorecard: { total_score: 90, did_close: true } });
  assert.equal(score.total_score, 90);
  assert.equal((await db.getScorecardHistory(rec.recording_id)).length, 1);
  const player = await db.findOrCreatePlayer({ email: 'lab@example.invalid', name: 'Synthetic player', location_id: loc.location_id });
  assert.equal((await db.getPlayerById(player.player_id)).display_name, 'Synthetic player');
  await db.findOrCreatePlayer({ email: 'lab@example.invalid', name: 'Updated lab player', location_id: loc.location_id });
  assert.equal((await db.getPlayerByEmail('lab@example.invalid')).display_name, 'Updated lab player');
  const session = randomUUID();
  await db.savePracticeSession({ session_id: session, location_id: loc.location_id, difficulty: 'easy', player_id: player.player_id, player_name: 'Synthetic player', mode: 'game', messages: [], scorecard: { total_score: 90 } });
  assert.ok((await db.getAllPracticeSessions()).some(x => x.session_id === session));
  assert.ok((await db.getAllRecordings()).some(x => x.recording_id === rec.recording_id));
  assert.ok((await db.getAllScorecards()).some(x => x.scorecard_id === score.scorecard_id));
  await db.getPlayerGameProgress(player.player_id);
  await db.getPlayerStreak(player.player_id);
  await db.getGameLeaderboard();
  assert.equal(await db.deleteCustomLocation(loc.location_id), true);
  console.log(JSON.stringify({ real_db_module: true, queries, five_table_workflows_passed: true, external_services_called: false }));
})().catch(() => { console.error('Restored scorecard DB smoke failed; no live services called'); process.exitCode = 1; });
