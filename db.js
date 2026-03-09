// db.js
// ─────────────────────────────────────────────────────────
// Simple in-memory database for Phase 1.
// All data lives in memory — resets on server restart.
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
    processing_status: 'pending'
  };
  recordings.set(recording.recording_id, recording);
  console.log('[DB] Created recording ' + recording.recording_id + ' for appt ' + appointment_id);
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
// Accepts both call shapes:
//   New:    { recording_id, scorecard }
//   Legacy: { recording_id, scores, coaching, ai_summary }

function createScorecard({ recording_id, scorecard, scores, coaching, ai_summary }) {
  const sc = scorecard || Object.assign({}, scores, coaching, { ai_summary });
  const flat = (val) => typeof val === 'string' ? val : JSON.stringify(val || {});
  const entry = {
    scorecard_id: uuidv4(),
    recording_id,
    total_score: sc.total_score || 0,
    sitdown_score: sc.sitdown_score || 0,
    objection_score: sc.objection_score || 0,
    language_score: sc.language_score || 0,
    close_score: sc.close_score || 0,
    ai_summary: sc.ai_summary || '',
    sitdown_coaching: flat(sc.sitdown_coaching),
    objection_coaching: flat(sc.objection_coaching),
    language_coaching: flat(sc.language_coaching),
    close_coaching: flat(sc.close_coaching),
    flagged_for_review: (sc.total_score || 0) < (parseInt(process.env.FLAG_SCORE_THRESHOLD) || 70),
    created_at: new Date().toISOString()
  };
  scorecards.set(entry.scorecard_id, entry);
  console.log('[DB] Created scorecard ' + entry.scorecard_id + ' score: ' + entry.total_score);
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
