// db.js
// ─────────────────────────────────────────────────────────
// Simple in-memory database for Phase 1.
// All data lives in memory — resets on server restart.
// In Phase 2 we'll swap this for Supabase Postgres.
// ─────────────────────────────────────────────────────────

const { v4: uuidv4 } = require('uuid');

const recordings = new Map();
const scorecards = new Map();

// ─── Recordings ───────────────────────────────────────────

function createRecording({ appointment_id, location_id, duration_seconds, audio_file_url }) {
  const recording = {
    recording_id: uuidv4(),
    appointment_id,
    location_id,
    audio_file_url: audio_file_url || null,
    transcript: null,
    duration_seconds: duration_seconds || 0,
    recorded_at: new Date().toISOString(),
    processing_status: 'pending' // pending → transcribed → scored → failed
  };
  recordings.set(recording.recording_id, recording);
  console.log(`[DB] Created recording ${recording.recording_id} for appt ${appointment_id}`);
  return recording;
}

function updateRecording(recording_id, updates) {
  const rec = recordings.get(recording_id);
  if (!rec) return null;
  Object.assign(rec, updates);
  recordings.set(recording_id, rec);
  return rec;
}

function getRecording(recording_id) {
  return recordings.get(recording_id) || null;
}

function getAllRecordings() {
  return Array.from(recordings.values()).sort((a, b) =>
    new Date(b.recorded_at) - new Date(a.recorded_at)
  );
}

// ─── Scorecards ───────────────────────────────────────────

function createScorecard({ recording_id, scorecard }) {
  const entry = {
    scorecard_id: uuidv4(),
    recording_id,
    total_score: scorecard.total_score,
    sitdown_score: scorecard.sitdown_score,
    objection_score: scorecard.objection_score,
    language_score: scorecard.language_score,
    close_score: scorecard.close_score,
    ai_summary: scorecard.ai_summary,
    sitdown_coaching: typeof scorecard.sitdown_coaching === 'string'
      ? scorecard.sitdown_coaching
      : JSON.stringify(scorecard.sitdown_coaching),
    objection_coaching: typeof scorecard.objection_coaching === 'string'
      ? scorecard.objection_coaching
      : JSON.stringify(scorecard.objection_coaching),
    language_coaching: typeof scorecard.language_coaching === 'string'
      ? scorecard.language_coaching
      : JSON.stringify(scorecard.language_coaching),
    close_coaching: typeof scorecard.close_coaching === 'string'
      ? scorecard.close_coaching
      : JSON.stringify(scorecard.close_coaching),
    flagged_for_review: scorecard.total_score < (parseInt(process.env.FLAG_SCORE_THRESHOLD) || 70),
    created_at: new Date().toISOString()
  };
  scorecards.set(entry.scorecard_id, entry);
  console.log(`[DB] Created scorecard ${entry.scorecard_id} — score: ${entry.total_score}`);
  return entry;
}

function getScorecardByRecording(recording_id) {
  return Array.from(scorecards.values()).find(s => s.recording_id === recording_id) || null;
}

function getAllScorecards() {
  return Array.from(scorecards.values()).sort((a, b) =>
    new Date(b.created_at) - new Date(a.created_at)
  );
}

module.exports = {
  createRecording,
  updateRecording,
  getRecording,
  getAllRecordings,
  createScorecard,
  getScorecardByRecording,
  getAllScorecards
};
