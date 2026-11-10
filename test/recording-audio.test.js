const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recordingAudioForTranscription } = require('../recording-audio');

test('uses the existing upload without restoring or deleting it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aira-recording-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const local = path.join(dir, 'original.m4a');
  fs.writeFileSync(local, 'audio');
  let downloads = 0;
  const result = await recordingAudioForTranscription({
    audioFilePath: local,
    r2Key: 'recordings/recording-1.m4a',
    recordingId: 'recording-1',
    uploadDir: dir,
    downloadFromR2: async () => { downloads += 1; },
  });
  assert.deepEqual(result, { filePath: local, temporary: false });
  assert.equal(downloads, 0);
});

test('restores an archived upload when its local file is gone', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aira-recording-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let downloadedKey;
  const result = await recordingAudioForTranscription({
    audioFilePath: path.join(dir, 'old-local-file.m4a'),
    r2Key: 'recordings/recording-2.m4a',
    recordingId: 'recording-2',
    uploadDir: dir,
    downloadFromR2: async (key, filePath) => {
      downloadedKey = key;
      fs.writeFileSync(filePath, 'archived audio');
    },
  });
  assert.equal(downloadedKey, 'recordings/recording-2.m4a');
  assert.equal(result.temporary, true);
  assert.equal(path.extname(result.filePath), '.m4a');
  assert.equal(fs.readFileSync(result.filePath, 'utf8'), 'archived audio');
});

test('rejects missing or mismatched archives', async () => {
  for (const key of [null, 'recordings/other-recording.m4a', 'recordings/recording-3.txt']) {
    await assert.rejects(recordingAudioForTranscription({
      audioFilePath: '/missing/local.m4a',
      r2Key: key,
      recordingId: 'recording-3',
      uploadDir: os.tmpdir(),
      downloadFromR2: async () => assert.fail('unexpected download'),
    }), /valid R2 archive/);
  }
});
