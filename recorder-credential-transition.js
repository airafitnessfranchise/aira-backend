const crypto = require('node:crypto');

// Secondary keys are a temporary reader capability only. Issuers and senders
// keep using their current primary. A missing primary never falls back.
function readKeys(env, primaryName, previousName) {
  const primary = env[primaryName];
  if (typeof primary !== 'string' || !primary) return [];
  const keys = [primary];
  const previous = env[previousName];
  if (env.RECORDER_CREDENTIAL_ROTATION_ENABLED === 'true'
      && typeof previous === 'string' && previous && previous !== primary) {
    keys.push(previous);
  }
  return keys;
}

function verificationError() {
  const error = new Error('Recorder credential is invalid or unavailable');
  error.status = 401;
  return error;
}

function verifyWithRecorderSigningKeys(token, verify, env = process.env) {
  for (const key of readKeys(env, 'RECORDER_TOKEN_SECRET', 'RECORDER_PREVIOUS_TOKEN_SECRET')) {
    try { return verify(token, key); } catch { /* Never log signed input. */ }
  }
  throw verificationError();
}

function equalOpaqueSecret(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !provided || !expected) return false;
  const hash = value => crypto.createHash('sha256').update(value, 'utf8').digest();
  return crypto.timingSafeEqual(hash(provided), hash(expected));
}

function recorderSyncMatches(provided, env = process.env) {
  let accepted = false;
  for (const key of readKeys(env, 'RECORDER_SYNC_SECRET', 'RECORDER_PREVIOUS_SYNC_SECRET')) {
    // Evaluate every configured comparison, including after a primary match.
    accepted = equalOpaqueSecret(provided, key) || accepted;
  }
  return accepted;
}

module.exports = { verifyWithRecorderSigningKeys, recorderSyncMatches, equalOpaqueSecret };

