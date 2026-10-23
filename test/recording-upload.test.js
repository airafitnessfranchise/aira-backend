const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createRecordingUpload, audioExtensionForUpload } = require('../recording-upload');

async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aira-upload-test-'));
  const app = express();
  app.post('/upload', (req, res, next) => req.headers.authorization === 'Bearer synthetic-staff'
    ? next() : res.status(401).end(), createRecordingUpload({ directory, maxFileSize: 1024 }), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false });
    res.json({ success: true, filename: req.file.filename, body: req.body, size: req.file.size });
  });
  app.get('/alive', (req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const upload = (body, headers = {}) => fetch(base + '/upload', {
    method: 'POST', headers: { authorization: 'Bearer synthetic-staff', ...headers }, body,
  });
  try { await run({ upload, directory, base }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); }
}
function form(name = 'audio_file', bytes = 12, filename = 'sample.m4a') {
  const data = new FormData();
  data.append('appointment_id', 'synthetic-appointment');
  data.append(name, new Blob([Buffer.alloc(bytes, 1)], { type: 'audio/mp4' }), filename);
  return data;
}
test('valid recording preserves multipart metadata and supported filename formats', () => fixture(async ({ upload, directory }) => {
  for (const extension of ['.m4a', '.mp4', '.webm', '.mp3', '.wav', '.mpeg', '.mpga']) {
    const response = await upload(form('audio_file', 12, `sample${extension}`));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.body.appointment_id, 'synthetic-appointment');
    assert.equal(result.size, 12); assert.ok(result.filename.endsWith(extension));
    assert.equal((await fs.readFile(path.join(directory, result.filename))).length, 12);
  }
}));
test('unauthenticated multipart is denied before any file is created', () => fixture(async ({ upload, directory }) => {
  assert.equal((await upload(form(), { authorization: '' })).status, 401);
  assert.deepEqual(await fs.readdir(directory), []);
}));
test('oversized and unexpected files are rejected and removed', () => fixture(async ({ upload, directory, base }) => {
  assert.equal((await upload(form('audio_file', 2048))).status, 413);
  assert.equal((await upload(form('other_file'))).status, 400);
  assert.deepEqual(await fs.readdir(directory), []);
  assert.equal((await fetch(base + '/alive')).status, 200);
}));
test('truncated multipart and missing boundary return 400 and server remains usable', () => fixture(async ({ upload, directory }) => {
  for (const [body, type] of [
    ['invalid', 'multipart/form-data'],
    ['--test\r\nContent-Disposition: form-data; name="audio_file"; filename="bad.wav"\r\nContent-Type: audio/wav\r\n\r\nincomplete', 'multipart/form-data; boundary=test'],
  ]) {
    const response = await upload(body, { 'content-type': type });
    assert.equal(response.status, 400); assert.equal((await response.json()).success, false);
  }
  assert.deepEqual(await fs.readdir(directory), []);
  assert.equal((await upload(form())).status, 200);
}));
test('an interrupted upload is cleaned up and the next upload succeeds', () => fixture(async ({ base, directory, upload }) => {
  await new Promise((resolve, reject) => {
    const request = http.request(base + '/upload', { method: 'POST', headers: {
      authorization: 'Bearer synthetic-staff', 'content-type': 'multipart/form-data; boundary=test',
    } });
    request.on('error', error => error.code === 'ECONNRESET' ? resolve() : reject(error));
    request.write('--test\r\nContent-Disposition: form-data; name="audio_file"; filename="interrupted.wav"\r\nContent-Type: audio/wav\r\n\r\nbytes');
    setTimeout(() => request.destroy(), 30);
  });
  for (let i = 0; i < 20 && (await fs.readdir(directory)).length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(await fs.readdir(directory), []);
  assert.equal((await upload(form())).status, 200);
}));
test('MIME fallback retains the recorder audio formats', () => {
  assert.equal(audioExtensionForUpload({ originalname: 'sample.unknown', mimetype: 'audio/mp4' }), '.m4a');
  assert.equal(audioExtensionForUpload({ originalname: 'sample', mimetype: 'audio/mpeg' }), '.mp3');
  assert.equal(audioExtensionForUpload({ originalname: 'sample', mimetype: 'audio/wav' }), '.wav');
  assert.equal(audioExtensionForUpload({}), '.webm');
});
test('production route authenticates before the multipart parser', async () => {
  const source = await fs.readFile(path.join(__dirname, '../server.js'), 'utf8');
  assert.match(source, /app\.post\(\s*"\/upload\/recording",\s*requireAiraStaffBearer,\s*recordingUpload,/);
});
