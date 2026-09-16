const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { createAdminAuth } = require('../admin-auth');

const signingSecret = 'synthetic-staff-signing-fixture-not-a-live-key';
const recoveryPassword = crypto.randomBytes(32).toString('base64url');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const verifierSource = source.slice(source.indexOf('function base64url('), source.indexOf('function signRecordingResultToken('));
assert.ok(verifierSource.includes('function verifyStaffToken('));
const sandbox = { Buffer, crypto, process: { env: { RECORDER_TOKEN_SECRET: signingSecret } } };
vm.createContext(sandbox);
vm.runInContext(verifierSource, sandbox);

function signToken(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'AIRA-RECORDER' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: 'aira-api', aud: 'aira-backend', sub: 'synthetic-staff', role: 'vp', email: 'fixture@example.invalid', name: 'Fixture', location_ids: ['  TEST-GYM  '], nbf: now - 30, exp: now + 60, ...overrides })).toString('base64url');
  const input = `${header}.${payload}`;
  return `${input}.${crypto.createHmac('sha256', signingSecret).update(input).digest('base64url')}`;
}
function basic(user, password) { return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`; }
function exercise({ env = {}, authorization, query = {} } = {}) {
  const req = { headers: authorization ? { authorization } : {}, query };
  const res = { statusCode: 200, headers: {}, set(k,v) { this.headers[k.toLowerCase()] = v; return this; }, status(n) { this.statusCode = n; return this; }, send(body) { this.body = body; return this; } };
  let allowed = 0;
  createAdminAuth({ env, verifyStaffToken: sandbox.verifyStaffToken, normalizeLocationId: id => String(id || '').toLowerCase().trim() })(req, res, () => allowed++);
  return { req, res, allowed };
}

test('missing recovery configuration denies Basic credentials and gives a usable sign-in instruction', () => {
  const r = exercise({ authorization: basic('admin', 'old-shared-password') });
  assert.equal(r.allowed, 0); assert.equal(r.res.statusCode, 401);
  assert.match(r.res.body, /Open Scorecards from Aira Admin/);
  assert.equal(r.res.headers['www-authenticate'], undefined);
});
test('empty, short and whitespace-only recovery configurations fail closed', () => {
  for (const password of ['', 'short-password', ' '.repeat(64)]) {
    const r = exercise({ env: { ADMIN_PASSWORD: password }, authorization: basic('admin', password) });
    assert.equal(r.allowed, 0); assert.equal(r.res.statusCode, 401);
  }
});
test('explicit strong recovery credential works and preserves owner scope', () => {
  const r = exercise({ env: { ADMIN_PASSWORD: recoveryPassword }, authorization: basic('admin', recoveryPassword) });
  assert.equal(r.allowed, 1); assert.equal(r.req.staff.is_super, true); assert.equal(r.req.staff.role, 'super_admin');
});
test('wrong recovery username or password is rejected', () => {
  for (const authorization of [basic('other', recoveryPassword), basic('admin', recoveryPassword + 'wrong')]) {
    const r = exercise({ env: { ADMIN_PASSWORD: recoveryPassword }, authorization });
    assert.equal(r.allowed, 0); assert.equal(r.res.statusCode, 401);
  }
});
test('recovery password parsing preserves colons and accepts case-insensitive Basic scheme', () => {
  const password = recoveryPassword + ':suffix';
  assert.equal(exercise({ env: { ADMIN_PASSWORD: password }, authorization: basic('admin', password).replace('Basic', 'basic') }).allowed, 1);
});
test('malformed authorization is rejected without throwing', () => {
  for (const authorization of ['Basic ???', 'Basic', 'Bearer broken', 'Digest whatever', 'Basic YWRtaW4=']) {
    assert.equal(exercise({ env: { ADMIN_PASSWORD: recoveryPassword, RECORDER_TOKEN_SECRET: signingSecret }, authorization }).allowed, 0);
  }
});
for (const role of ['super_admin', 'vp', 'franchisee']) {
  test(`existing signed ${role} token works without Basic recovery configuration`, () => {
    const token = signToken({ role });
    const r = exercise({ env: { RECORDER_TOKEN_SECRET: signingSecret }, authorization: `Bearer ${token}` });
    assert.equal(r.allowed, 1); assert.equal(r.req.staff.role, role);
    assert.equal(r.req.staff.is_super, role === 'super_admin');
    assert.deepEqual([...r.req.staff.location_ids], ['test-gym']);
    assert.equal(r.req.staffToken, token);
  });
}
test('existing query-token navigation works and is marked no-store/no-referrer', () => {
  const r = exercise({ env: { RECORDER_TOKEN_SECRET: signingSecret }, query: { staff_token: signToken() } });
  assert.equal(r.allowed, 1); assert.equal(r.res.headers['cache-control'], 'no-store'); assert.equal(r.res.headers['referrer-policy'], 'no-referrer');
});
test('expired, wrong-role, wrong-audience and wrong-issuer staff tokens are rejected', () => {
  for (const fields of [{ exp: 1 }, { role: 'member' }, { aud: 'another-service' }, { iss: 'another-issuer' }]) {
    assert.equal(exercise({ env: { RECORDER_TOKEN_SECRET: signingSecret }, authorization: `Bearer ${signToken(fields)}` }).allowed, 0);
  }
});
test('tampered staff signature is rejected', () => {
  const parts = signToken().split('.'); parts[2] = 'x'.repeat(parts[2].length);
  assert.equal(exercise({ env: { RECORDER_TOKEN_SECRET: signingSecret }, query: { staff_token: parts.join('.') } }).allowed, 0);
});
test('unconfigured token auth and non-string query tokens are rejected', () => {
  assert.equal(exercise({ authorization: `Bearer ${signToken()}` }).allowed, 0);
  assert.equal(exercise({ env: { RECORDER_TOKEN_SECRET: signingSecret }, query: { staff_token: ['one', 'two'] } }).allowed, 0);
});
test('signed scoped access stays available even with an unusable recovery configuration', () => {
  const r = exercise({ env: { RECORDER_TOKEN_SECRET: signingSecret, ADMIN_PASSWORD: 'too-short' }, authorization: `Bearer ${signToken()}` });
  assert.equal(r.allowed, 1); assert.equal(r.req.staff.is_super, false);
});
test('server routes retain the protected middleware and no default password expression', () => {
  assert.match(source, /const adminAuth = createAdminAuth\(\{ verifyStaffToken, normalizeLocationId \}\)/);
  assert.doesNotMatch(source, /ADMIN_PASSWORD\s*\|\|/);
  for (const route of ['/admin', '/admin/locations', '/admin/location/:id', '/admin/library', '/scorecard/:id', '/playback/:recording_id']) {
    assert.ok(source.includes(`app.get("${route}", adminAuth,`), route);
  }
});
test('HTTP smoke permits signed access while rejecting unauthenticated and Basic fallback access', async (t) => {
  const middleware = createAdminAuth({ env: { RECORDER_TOKEN_SECRET: signingSecret }, verifyStaffToken: sandbox.verifyStaffToken, normalizeLocationId: String });
  const server = http.createServer((req, res) => {
    req.query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
    res.set = (k,v) => { res.setHeader(k,v); return res; };
    res.status = n => { res.statusCode=n; return res; };
    res.send = body => res.end(body);
    middleware(req,res,() => res.end('authorized fixture'));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/protected-fixture`;
  const denied = await fetch(url); assert.equal(denied.status,401); await denied.text();
  const old = await fetch(url,{headers:{authorization:basic('admin','old-shared-password')}}); assert.equal(old.status,401); await old.text();
  const allowed = await fetch(url,{headers:{authorization:`Bearer ${signToken()}`}}); assert.equal(allowed.status,200); assert.equal(await allowed.text(),'authorized fixture');
});
