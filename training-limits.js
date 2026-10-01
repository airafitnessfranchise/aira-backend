// Detailed scorecards need more time than a conversational response.
// Keep this shared with the guard so an in-flight score retains its slot.
const TRAINING_SCORE_TIMEOUT_MS = 120_000;
module.exports = { TRAINING_SCORE_TIMEOUT_MS };
