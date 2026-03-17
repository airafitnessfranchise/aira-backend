// db.js — Postgres (Supabase) persistent storage
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ─── Init tables on startup ─────────────────────────────
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recordings (
      recording_id    TEXT PRIMARY KEY,
      appointment_id  TEXT,
      location_id     TEXT,
      contact_name    TEXT DEFAULT 'Walk-in',
      audio_file_url  TEXT,
      r2_key          TEXT,
      transcript      TEXT,
      duration_seconds INTEGER DEFAULT 0,
      recorded_at     TIMESTAMPTZ DEFAULT NOW(),
      processing_status TEXT DEFAULT 'pending'
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scorecards (
      scorecard_id    TEXT PRIMARY KEY,
      recording_id    TEXT REFERENCES recordings(recording_id),
      total_score     INTEGER DEFAULT 0,
      sitdown_score   INTEGER DEFAULT 0,
      objection_score INTEGER DEFAULT 0,
      language_score  INTEGER DEFAULT 0,
      close_score     INTEGER DEFAULT 0,
      ai_summary      TEXT DEFAULT '',
      coaching_note   TEXT DEFAULT '',
      flagged_for_review BOOLEAN DEFAULT FALSE,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('[DB] Tables ready');
}

// ─── Recordings ─────────────────────────────────────────
async function createRecording({ appointment_id, location_id, duration_seconds, audio_file_url, contact_name }) {
  const recording_id = uuidv4();
  await pool.query(
    `INSERT INTO recordings (recording_id, appointment_id, location_id, duration_seconds, audio_file_url, contact_name)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [recording_id, appointment_id, location_id, duration_seconds || 0, audio_file_url || null, contact_name || 'Walk-in']
  );
  console.log('[DB] Created recording ' + recording_id + ' for appt ' + appointment_id);
  return getRecording(recording_id);
}

async function updateRecording(recording_id, updates) {
  const fields = Object.keys(updates);
  if (!fields.length) return getRecording(recording_id);
  const setClause = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
  await pool.query(
    `UPDATE recordings SET ${setClause} WHERE recording_id = $1`,
    [recording_id, ...fields.map(f => updates[f])]
  );
  return getRecording(recording_id);
}

async function getRecording(recording_id) {
  const { rows } = await pool.query('SELECT * FROM recordings WHERE recording_id = $1', [recording_id]);
  return rows[0] || null;
}

async function getAllRecordings() {
  const { rows } = await pool.query('SELECT * FROM recordings ORDER BY recorded_at DESC');
  return rows;
}

async function findRecordingByApptId(appointment_id) {
  const { rows } = await pool.query('SELECT * FROM recordings WHERE appointment_id = $1', [appointment_id]);
  return rows[0] || null;
}

// ─── Scorecards ─────────────────────────────────────────
async function createScorecard({ recording_id, scorecard }) {
  const sc = scorecard || {};
  const scorecard_id = uuidv4();
  const flagged = (sc.total_score || 0) < (parseInt(process.env.FLAG_SCORE_THRESHOLD) || 70);
  await pool.query(
    `INSERT INTO scorecards (scorecard_id, recording_id, total_score, sitdown_score, objection_score, language_score, close_score, ai_summary, coaching_note, flagged_for_review)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [scorecard_id, recording_id, sc.total_score || 0, sc.sitdown_score || 0, sc.objection_score || 0,
     sc.language_score || 0, sc.close_score || 0, sc.ai_summary || '', sc.coaching_note || '', flagged]
  );
  console.log('[DB] Created scorecard ' + scorecard_id + ' score: ' + (sc.total_score || 0));
  return getScorecardByRecording(recording_id);
}

async function getScorecardByRecording(recording_id) {
  const { rows } = await pool.query('SELECT * FROM scorecards WHERE recording_id = $1', [recording_id]);
  return rows[0] || null;
}

async function getAllScorecards() {
  const { rows } = await pool.query('SELECT * FROM scorecards ORDER BY created_at DESC');
  return rows;
}

module.exports = {
  initDb,
  createRecording,
  updateRecording,
  getRecording,
  getAllRecordings,
  findRecordingByApptId,
  createScorecard,
  getScorecardByRecording,
  getAllScorecards
};
