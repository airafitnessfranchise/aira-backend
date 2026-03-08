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

function createScorecard({ recording_id, scores, coaching, ai_summary }) {
  const scorecard = {
    scorecard_id: uuidv4(),
    recording_id,
    total_score: scores.total_score,
    rapport_score: scores.rapport_score,
    presentation_score: scores.presentation_score,
    objection_handling_score: scores.objection_handling_score,
    close_attempt_score: scores.close_attempt_score,
    followup_score: scores.followup_score,
    ai_summary,
    rapport_coaching: coaching.rapport_coaching,
    presentation_coaching: coaching.presentation_coaching,
    objection_coaching: coaching.objection_coaching,
    close_coaching: coaching.close_coaching,
    followup_coaching: coaching.followup_coaching,
    flagged_for_review: scores.total_score < (parseInt(process.env.FLAG_SCORE_THRESHOLD) || 70),
    created_at: new Date().toISOString()
  };
  scorecards.set(scorecard.scorecard_id, scorecard);
  console.log(`[DB] Created scorecard ${scorecard.scorecard_id} — score: ${scorecard.total_score}`);
  return scorecard;
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
