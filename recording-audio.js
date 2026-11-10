const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ARCHIVE_EXTENSIONS = new Set(['.m4a', '.mp4', '.mp3', '.mpeg', '.mpga', '.wav', '.webm']);

async function recordingAudioForTranscription({ audioFilePath, r2Key, recordingId, uploadDir, downloadFromR2 }) {
  if (audioFilePath && fs.existsSync(audioFilePath)) {
    return { filePath: audioFilePath, temporary: false };
  }
  const extension = path.extname(r2Key || '').toLowerCase();
  if (!r2Key || r2Key !== `recordings/${recordingId}${extension}` || !ARCHIVE_EXTENSIONS.has(extension)) {
    throw new Error('Recording audio is unavailable locally and has no valid R2 archive');
  }
  const filePath = path.join(uploadDir, `recovered-${crypto.randomUUID()}${extension}`);
  await downloadFromR2(r2Key, filePath);
  return { filePath, temporary: true };
}

module.exports = { recordingAudioForTranscription };
