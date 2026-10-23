const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createRequire } = require('node:module');

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
    process: { env: { PORT: '0' }, exit: denyProvider },
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
    assert.equal((await fetch(base + '/upload/recording', { method: 'POST' })).status, 401);
    assert.deepEqual(fs.readdirSync(path.join(directory, 'uploads')), []);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
