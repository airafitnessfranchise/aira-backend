const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createRequire } = require('node:module');
const { createTrainingToken } = require('../training-token');

test('actual server waits for startup before readiness and keeps uploads authenticated', async () => {
  const filename = path.join(__dirname, '../server.js');
  const realRequire = createRequire(filename);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aira-startup-test-'));
  let server, releaseDatabase;
  const startup = new Promise(resolve => { releaseDatabase = resolve; });
  const denyProvider = () => { throw new Error('Provider access forbidden in startup fixture'); };
  const stubs = {
    dotenv: { config: () => ({}) },
    './db': { initDb: () => startup, getCustomLocations: async () => [], findAndReapStuckRecordings: async () => [] },
    './ai': { getPracticeSession: () => null, PROSPECT_PERSONAS: {}, GAME_LEVELS: [], SKILL_DRILLS: [] },
    './email': { sendScorecardEmail: denyProvider, sendPracticeEmail: denyProvider },
    './storage': { uploadToR2: denyProvider, getPresignedUrl: denyProvider },
    './vp-routes': realRequire('express').Router(),
    axios: { get: denyProvider, post: denyProvider },
    http: { ...http, createServer: app => {
      server = http.createServer(app);
      const listen = server.listen.bind(server);
      server.listen = (port, callback) => listen(0, '127.0.0.1', callback);
      return server;
    } },
  };
  const context = {
    require: name => Object.hasOwn(stubs, name) ? stubs[name] : realRequire(name),
    __dirname: directory, __filename: filename, Buffer, URL, URLSearchParams, AbortSignal,
    process: { env: { PORT: '0', RECORDER_TOKEN_SECRET: 'synthetic-preopening-test-secret', PREOPENING_TRAINING_ENABLED: 'true' }, exit: denyProvider },
    console: { log() {}, warn() {}, error: denyProvider },
    setInterval: () => ({ unref() {} }), clearInterval() {}, setTimeout, clearTimeout,
    fetch: denyProvider,
  };
  try {
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    assert.equal(server.listening, false);
    const listening = new Promise(resolve => server.once('listening', resolve));
    releaseDatabase(); await listening;
    const base = `http://127.0.0.1:${server.address().port}`;
    const health = await fetch(base + '/health/ready');
    assert.equal(health.status, 200); assert.equal((await health.json()).runtime.node, '22.23.4');
    const traineeToken = createTrainingToken({ admin: { id: 'trainee', email: 'trainee@example.test', role: 'franchisee' }, features: ['practice', 'game'], locationIds: [], secret: context.process.env.RECORDER_TOKEN_SECRET }).token;
    for (const route of ['/practice', '/airafitnessclosinggame']) {
      const page = await fetch(`${base}${route}?training_token=${encodeURIComponent(traineeToken)}`);
      assert.equal(page.status, 200, route);
      const html = await page.text();
      assert.match(html, /Pre-opening training \(no gym needed\)/, route);
      assert.match(html, /const PREOPENING_MODE = true;/, route);
    }
    const assignedToken = createTrainingToken({ admin: { id: 'staff', email: 'staff@example.test', role: 'franchisee' }, features: ['practice', 'game'], locationIds: ['gym-a'], secret: context.process.env.RECORDER_TOKEN_SECRET }).token;
    const assignedPage = await fetch(`${base}/practice?training_token=${encodeURIComponent(assignedToken)}`);
    assert.equal(assignedPage.status, 200);
    const assignedHtml = await assignedPage.text();
    assert.match(assignedHtml, /const PREOPENING_MODE = false;/);
    assert.doesNotMatch(assignedHtml, /Pre-opening training \(no gym needed\)/);
    context.process.env.PREOPENING_TRAINING_ENABLED = 'false';
    const disabledPage = await fetch(`${base}/practice?training_token=${encodeURIComponent(traineeToken)}`);
    assert.equal(disabledPage.status, 200);
    assert.doesNotMatch(await disabledPage.text(), /Pre-opening training \(no gym needed\)/);
    assert.equal((await fetch(base + '/upload/recording', { method: 'POST' })).status, 401);
    assert.deepEqual(fs.readdirSync(path.join(directory, 'uploads')), []);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
