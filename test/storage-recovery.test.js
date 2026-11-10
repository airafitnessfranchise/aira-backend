const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { downloadFromR2 } = require('../storage');

test('streams archived audio to a new local file', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aira-r2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'audio.m4a');
  const client = { send: async () => ({ Body: Readable.from(['archived ', 'audio']) }) };
  await downloadFromR2('recordings/test.m4a', target, client);
  assert.equal(fs.readFileSync(target, 'utf8'), 'archived audio');
});

test('removes a partial local file if the archive stream fails', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aira-r2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'audio.m4a');
  const client = { send: async () => ({ Body: Readable.from((async function* () {
    yield 'partial';
    throw new Error('interrupted archive');
  })()) }) };
  await assert.rejects(downloadFromR2('recordings/test.m4a', target, client), /interrupted archive/);
  assert.equal(fs.existsSync(target), false);
});

test('does not overwrite or delete an existing local file', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aira-r2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'audio.m4a');
  fs.writeFileSync(target, 'keep this audio');
  const client = { send: async () => ({ Body: Readable.from(['new audio']) }) };
  await assert.rejects(downloadFromR2('recordings/test.m4a', target, client), /EEXIST/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep this audio');
});
