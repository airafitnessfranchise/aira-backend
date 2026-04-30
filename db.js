// db.js — Postgres (Supabase) persistent storage
const { Pool } = require("pg");
const { v4: uuidv4 } = require("uuid");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
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
      did_close       BOOLEAN DEFAULT FALSE,
      sitdown_score_explainer    TEXT DEFAULT '',
      objection_score_explainer  TEXT DEFAULT '',
      language_score_explainer   TEXT DEFAULT '',
      close_score_explainer      TEXT DEFAULT '',
      sitdown_what_said    TEXT DEFAULT '',
      sitdown_what_to_say  TEXT DEFAULT '',
      sitdown_coaching     TEXT DEFAULT '',
      objection_what_said    TEXT DEFAULT '',
      objection_what_to_say  TEXT DEFAULT '',
      objection_coaching     TEXT DEFAULT '',
      language_what_said    TEXT DEFAULT '',
      language_what_to_say  TEXT DEFAULT '',
      language_coaching     TEXT DEFAULT '',
      close_what_said    TEXT DEFAULT '',
      close_what_to_say  TEXT DEFAULT '',
      close_coaching     TEXT DEFAULT '',
      process_warning   TEXT DEFAULT '',
      overall_coaching  TEXT DEFAULT '',
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS practice_sessions (
      session_id      TEXT PRIMARY KEY,
      location_id     TEXT,
      difficulty      TEXT,
      persona_label   TEXT,
      scenario_id     TEXT,
      player_id       TEXT,
      player_name     TEXT,
      mode            TEXT DEFAULT 'practice',
      messages        JSONB,
      total_score     INTEGER DEFAULT 0,
      sitdown_score   INTEGER DEFAULT 0,
      objection_score INTEGER DEFAULT 0,
      language_score  INTEGER DEFAULT 0,
      close_score     INTEGER DEFAULT 0,
      did_close       BOOLEAN DEFAULT FALSE,
      ai_summary      TEXT DEFAULT '',
      overall_coaching TEXT DEFAULT '',
      sitdown_score_explainer TEXT DEFAULT '',
      objection_score_explainer TEXT DEFAULT '',
      language_score_explainer TEXT DEFAULT '',
      close_score_explainer TEXT DEFAULT '',
      sitdown_what_said TEXT DEFAULT '',
      sitdown_what_to_say TEXT DEFAULT '',
      sitdown_coaching TEXT DEFAULT '',
      objection_what_said TEXT DEFAULT '',
      objection_what_to_say TEXT DEFAULT '',
      objection_coaching TEXT DEFAULT '',
      language_what_said TEXT DEFAULT '',
      language_what_to_say TEXT DEFAULT '',
      language_coaching TEXT DEFAULT '',
      close_what_said TEXT DEFAULT '',
      close_what_to_say TEXT DEFAULT '',
      close_coaching TEXT DEFAULT '',
      process_warning TEXT DEFAULT '',
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Add columns to existing tables that pre-date them.
  await pool.query(
    `ALTER TABLE practice_sessions ADD COLUMN IF NOT EXISTS scenario_id TEXT`,
  );
  await pool.query(
    `ALTER TABLE practice_sessions ADD COLUMN IF NOT EXISTS player_id TEXT`,
  );
  await pool.query(
    `ALTER TABLE practice_sessions ADD COLUMN IF NOT EXISTS player_name TEXT`,
  );
  await pool.query(
    `ALTER TABLE practice_sessions ADD COLUMN IF NOT EXISTS mode TEXT DEFAULT 'practice'`,
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      player_id    TEXT PRIMARY KEY,
      email        TEXT UNIQUE NOT NULL,
      display_name TEXT,
      location_id  TEXT,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      last_seen    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS custom_locations (
      location_id      TEXT PRIMARY KEY,
      franchise_name   TEXT NOT NULL,
      franchisee_name  TEXT DEFAULT '',
      franchisee_email TEXT NOT NULL,
      vp_email         TEXT DEFAULT '',
      club_email       TEXT DEFAULT '',
      ghl_calendar_id  TEXT DEFAULT '',
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log("[DB] Tables ready");
}

// ─── Custom locations (added via /admin/locations UI, merge with hardcoded locations.js) ───

async function getCustomLocations() {
  const { rows } = await pool.query(
    `SELECT * FROM custom_locations ORDER BY created_at ASC`,
  );
  return rows;
}

async function addCustomLocation(loc) {
  await pool.query(
    `INSERT INTO custom_locations (
      location_id, franchise_name, franchisee_name, franchisee_email, vp_email, club_email, ghl_calendar_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (location_id) DO UPDATE SET
      franchise_name = EXCLUDED.franchise_name,
      franchisee_name = EXCLUDED.franchisee_name,
      franchisee_email = EXCLUDED.franchisee_email,
      vp_email = EXCLUDED.vp_email,
      club_email = EXCLUDED.club_email,
      ghl_calendar_id = EXCLUDED.ghl_calendar_id`,
    [
      loc.location_id,
      loc.franchise_name,
      loc.franchisee_name || "",
      loc.franchisee_email,
      loc.vp_email || "",
      loc.club_email || "",
      loc.ghl_calendar_id || "",
    ],
  );
  console.log(
    `[DB] Saved custom location ${loc.location_id} (${loc.franchise_name})`,
  );
}

async function deleteCustomLocation(location_id) {
  const { rowCount } = await pool.query(
    `DELETE FROM custom_locations WHERE location_id = $1`,
    [location_id],
  );
  console.log(`[DB] Deleted custom location ${location_id} (${rowCount} row)`);
  return rowCount > 0;
}

// ─── Recordings ─────────────────────────────────────────
async function createRecording({
  appointment_id,
  location_id,
  duration_seconds,
  audio_file_url,
  contact_name,
}) {
  const recording_id = uuidv4();
  await pool.query(
    `INSERT INTO recordings (recording_id, appointment_id, location_id, duration_seconds, audio_file_url, contact_name)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      recording_id,
      appointment_id,
      location_id,
      duration_seconds || 0,
      audio_file_url || null,
      contact_name || "Walk-in",
    ],
  );
  console.log(
    "[DB] Created recording " + recording_id + " for appt " + appointment_id,
  );
  return getRecording(recording_id);
}

async function updateRecording(recording_id, updates) {
  const fields = Object.keys(updates);
  if (!fields.length) return getRecording(recording_id);
  const setClause = fields.map((f, i) => `${f} = $${i + 2}`).join(", ");
  await pool.query(
    `UPDATE recordings SET ${setClause} WHERE recording_id = $1`,
    [recording_id, ...fields.map((f) => updates[f])],
  );
  return getRecording(recording_id);
}

async function getRecording(recording_id) {
  const { rows } = await pool.query(
    "SELECT * FROM recordings WHERE recording_id = $1",
    [recording_id],
  );
  return rows[0] || null;
}

async function getAllRecordings() {
  const { rows } = await pool.query(
    "SELECT * FROM recordings ORDER BY recorded_at DESC",
  );
  return rows;
}

async function findRecordingByApptId(appointment_id) {
  const { rows } = await pool.query(
    "SELECT * FROM recordings WHERE appointment_id = $1",
    [appointment_id],
  );
  return rows[0] || null;
}

async function findAndReapStuckRecordings() {
  const { rows } = await pool.query(
    `SELECT recording_id, appointment_id, location_id, audio_file_url, transcript, processing_status, recorded_at,
            EXTRACT(EPOCH FROM (NOW() - recorded_at)) / 60 AS age_minutes
     FROM recordings
     WHERE processing_status IN ('transcribing','scoring')
       AND recorded_at < NOW() - INTERVAL '5 minutes'`,
  );
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.recording_id);
  await pool.query(
    `UPDATE recordings SET processing_status = 'uploaded' WHERE recording_id = ANY($1::text[])`,
    [ids],
  );
  return rows;
}

// ─── Scorecards ─────────────────────────────────────────
async function createScorecard({ recording_id, scorecard }) {
  const sc = scorecard || {};
  const scorecard_id = uuidv4();
  const flagged =
    (sc.total_score || 0) < (parseInt(process.env.FLAG_SCORE_THRESHOLD) || 70);
  await pool.query(
    `INSERT INTO scorecards (
      scorecard_id, recording_id,
      total_score, sitdown_score, objection_score, language_score, close_score,
      ai_summary, coaching_note, flagged_for_review, did_close,
      sitdown_score_explainer, objection_score_explainer,
      language_score_explainer, close_score_explainer,
      sitdown_what_said, sitdown_what_to_say, sitdown_coaching,
      objection_what_said, objection_what_to_say, objection_coaching,
      language_what_said, language_what_to_say, language_coaching,
      close_what_said, close_what_to_say, close_coaching,
      process_warning, overall_coaching
    ) VALUES (
      $1, $2,
      $3, $4, $5, $6, $7,
      $8, $9, $10, $11,
      $12, $13, $14, $15,
      $16, $17, $18,
      $19, $20, $21,
      $22, $23, $24,
      $25, $26, $27,
      $28, $29
    )`,
    [
      scorecard_id,
      recording_id,
      sc.total_score || 0,
      sc.sitdown_score || 0,
      sc.objection_score || 0,
      sc.language_score || 0,
      sc.close_score || 0,
      sc.ai_summary || "",
      sc.coaching_note || sc.overall_coaching || "",
      flagged,
      sc.did_close === true,
      sc.sitdown_score_explainer || "",
      sc.objection_score_explainer || "",
      sc.language_score_explainer || "",
      sc.close_score_explainer || "",
      sc.sitdown_what_said || "",
      sc.sitdown_what_to_say || "",
      sc.sitdown_coaching || "",
      sc.objection_what_said || "",
      sc.objection_what_to_say || "",
      sc.objection_coaching || "",
      sc.language_what_said || "",
      sc.language_what_to_say || "",
      sc.language_coaching || "",
      sc.close_what_said || "",
      sc.close_what_to_say || "",
      sc.close_coaching || "",
      sc.process_warning || "",
      sc.overall_coaching || "",
    ],
  );
  console.log(
    "[DB] Created scorecard " +
      scorecard_id +
      " score: " +
      (sc.total_score || 0) +
      " closed: " +
      (sc.did_close === true),
  );
  return getScorecardByRecording(recording_id);
}

async function getScorecardByRecording(recording_id) {
  const { rows } = await pool.query(
    "SELECT * FROM scorecards WHERE recording_id = $1 ORDER BY created_at DESC LIMIT 1",
    [recording_id],
  );
  return rows[0] || null;
}

async function getAllScorecards() {
  const { rows } = await pool.query(
    "SELECT * FROM scorecards ORDER BY created_at DESC",
  );
  return rows;
}

async function getScorecardHistory(recording_id) {
  const { rows } = await pool.query(
    "SELECT * FROM scorecards WHERE recording_id = $1 ORDER BY created_at ASC",
    [recording_id],
  );
  return rows;
}

async function savePracticeSession({
  session_id,
  location_id,
  difficulty,
  persona_label,
  scenario_id,
  player_id,
  player_name,
  mode,
  messages,
  scorecard,
}) {
  const sc = scorecard || {};
  await pool.query(
    `INSERT INTO practice_sessions (
      session_id, location_id, difficulty, persona_label, scenario_id, player_id, player_name, mode, messages,
      total_score, sitdown_score, objection_score, language_score, close_score, did_close,
      ai_summary, overall_coaching,
      sitdown_score_explainer, objection_score_explainer, language_score_explainer, close_score_explainer,
      sitdown_what_said, sitdown_what_to_say, sitdown_coaching,
      objection_what_said, objection_what_to_say, objection_coaching,
      language_what_said, language_what_to_say, language_coaching,
      close_what_said, close_what_to_say, close_coaching,
      process_warning
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,
      $10,$11,$12,$13,$14,$15,
      $16,$17,
      $18,$19,$20,$21,
      $22,$23,$24,
      $25,$26,$27,
      $28,$29,$30,
      $31,$32,$33,
      $34
    )
    ON CONFLICT (session_id) DO NOTHING`,
    [
      session_id,
      location_id,
      difficulty,
      persona_label,
      scenario_id || null,
      player_id || null,
      player_name || null,
      mode || "practice",
      JSON.stringify(messages),
      sc.total_score || 0,
      sc.sitdown_score || 0,
      sc.objection_score || 0,
      sc.language_score || 0,
      sc.close_score || 0,
      sc.did_close === true,
      sc.ai_summary || "",
      sc.overall_coaching || "",
      sc.sitdown_score_explainer || "",
      sc.objection_score_explainer || "",
      sc.language_score_explainer || "",
      sc.close_score_explainer || "",
      sc.sitdown_what_said || "",
      sc.sitdown_what_to_say || "",
      sc.sitdown_coaching || "",
      sc.objection_what_said || "",
      sc.objection_what_to_say || "",
      sc.objection_coaching || "",
      sc.language_what_said || "",
      sc.language_what_to_say || "",
      sc.language_coaching || "",
      sc.close_what_said || "",
      sc.close_what_to_say || "",
      sc.close_coaching || "",
      sc.process_warning || "",
    ],
  );
  console.log(
    `[DB] Saved practice_session ${session_id} (${persona_label}, score: ${sc.total_score || 0})`,
  );
}

async function getAllPracticeSessions() {
  const { rows } = await pool.query(
    "SELECT * FROM practice_sessions ORDER BY created_at DESC",
  );
  return rows;
}

// Game progress for one player. Returns scenarios_passed (passed = closed AND
// total_score >= 70), total_xp, attempts_total, closes_total, leaderboard rank.
async function getPlayerGameProgress(player_id) {
  if (!player_id) return null;
  const { rows } = await pool.query(
    `SELECT scenario_id, MAX(total_score) AS best_score, BOOL_OR(did_close AND total_score >= 70) AS passed,
            COUNT(*) AS attempts, BOOL_OR(did_close) AS ever_closed
     FROM practice_sessions
     WHERE player_id = $1 AND mode = 'game' AND scenario_id IS NOT NULL
     GROUP BY scenario_id`,
    [player_id],
  );
  const totals = await pool.query(
    `SELECT COUNT(*) AS attempts_total,
            SUM(CASE WHEN did_close THEN 1 ELSE 0 END) AS closes_total,
            COALESCE(SUM(CASE WHEN did_close AND total_score >= 70 THEN total_score ELSE 0 END), 0) AS total_xp,
            MAX(player_name) AS player_name
     FROM practice_sessions
     WHERE player_id = $1 AND mode = 'game'`,
    [player_id],
  );
  return {
    per_scenario: rows.map((r) => ({
      scenario_id: r.scenario_id,
      best_score: r.best_score,
      passed: r.passed === true,
      attempts: Number(r.attempts),
      ever_closed: r.ever_closed === true,
    })),
    attempts_total: Number(totals.rows[0].attempts_total || 0),
    closes_total: Number(totals.rows[0].closes_total || 0),
    total_xp: Number(totals.rows[0].total_xp || 0),
    player_name: totals.rows[0].player_name || null,
  };
}

async function getGameLeaderboard(limit = 25) {
  const { rows } = await pool.query(
    `SELECT player_id,
            MAX(player_name) AS player_name,
            MAX(location_id) AS location_id,
            COALESCE(SUM(CASE WHEN did_close AND total_score >= 70 THEN total_score ELSE 0 END), 0) AS total_xp,
            SUM(CASE WHEN did_close THEN 1 ELSE 0 END) AS closes_total,
            COUNT(*) AS attempts_total,
            COUNT(DISTINCT CASE WHEN did_close AND total_score >= 70 THEN scenario_id END) AS scenarios_passed
     FROM practice_sessions
     WHERE mode = 'game' AND player_id IS NOT NULL
     GROUP BY player_id
     ORDER BY total_xp DESC
     LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    player_id: r.player_id,
    player_name: r.player_name,
    location_id: r.location_id,
    total_xp: Number(r.total_xp),
    closes_total: Number(r.closes_total),
    attempts_total: Number(r.attempts_total),
    scenarios_passed: Number(r.scenarios_passed),
  }));
}

// ─── Players (game identity by email — progress follows the rep across devices) ───

async function findOrCreatePlayer({
  email,
  name,
  location_id,
  claim_player_id,
}) {
  const lower = String(email || "")
    .toLowerCase()
    .trim();
  if (!lower) throw new Error("Email is required");

  // Email lookup
  const existing = await pool.query(
    "SELECT * FROM players WHERE LOWER(email) = $1",
    [lower],
  );
  if (existing.rows.length > 0) {
    const player = existing.rows[0];
    // Refresh last_seen + optionally update name/location if newly provided
    await pool.query(
      `UPDATE players
       SET last_seen = NOW(),
           display_name = COALESCE(NULLIF($1, ''), display_name),
           location_id = COALESCE(NULLIF($2, ''), location_id)
       WHERE player_id = $3`,
      [name || "", location_id || "", player.player_id],
    );
    // If this browser had a different cookie player_id with practice sessions, claim them
    if (claim_player_id && claim_player_id !== player.player_id) {
      const { rowCount } = await pool.query(
        `UPDATE practice_sessions
         SET player_id = $1, player_name = COALESCE(player_name, $2)
         WHERE player_id = $3 AND mode = 'game'`,
        [
          player.player_id,
          player.display_name || name || null,
          claim_player_id,
        ],
      );
      if (rowCount > 0) {
        console.log(
          `[Players] Claimed ${rowCount} prior session(s) from ${claim_player_id} → ${player.player_id} (${lower})`,
        );
      }
    }
    return {
      ...player,
      claimed: claim_player_id && claim_player_id !== player.player_id,
    };
  }

  // No player with this email — create one. Reuse the cookie's player_id if provided
  // so any sessions already saved under it stay attached automatically.
  const { v4: uuidv4 } = require("uuid");
  const player_id = claim_player_id || uuidv4();
  await pool.query(
    `INSERT INTO players (player_id, email, display_name, location_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (player_id) DO NOTHING`,
    [player_id, lower, name || null, location_id || null],
  );
  console.log(`[Players] Created new player ${player_id} (${lower})`);
  return {
    player_id,
    email: lower,
    display_name: name || null,
    location_id: location_id || null,
    claimed: false,
  };
}

async function getPlayerByEmail(email) {
  const { rows } = await pool.query(
    "SELECT * FROM players WHERE LOWER(email) = $1",
    [
      String(email || "")
        .toLowerCase()
        .trim(),
    ],
  );
  return rows[0] || null;
}

async function getPlayerById(player_id) {
  const { rows } = await pool.query(
    "SELECT * FROM players WHERE player_id = $1",
    [player_id],
  );
  return rows[0] || null;
}

module.exports = {
  initDb,
  createRecording,
  updateRecording,
  getRecording,
  getAllRecordings,
  findRecordingByApptId,
  findAndReapStuckRecordings,
  createScorecard,
  getScorecardByRecording,
  getScorecardHistory,
  getAllScorecards,
  savePracticeSession,
  getAllPracticeSessions,
  getPlayerGameProgress,
  getGameLeaderboard,
  getCustomLocations,
  addCustomLocation,
  deleteCustomLocation,
  findOrCreatePlayer,
  getPlayerByEmail,
  getPlayerById,
};
