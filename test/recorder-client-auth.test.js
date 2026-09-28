const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const recorderHtml = fs.readFileSync(
  path.join(__dirname, '../public/recorder.html'),
  'utf8',
);
const serverSource = fs.readFileSync(
  path.join(__dirname, '../server.js'),
  'utf8',
);

test('web recorder carries signed dashboard access into uploads without leaving it in the address', () => {
  assert.match(recorderHtml, /params\.get\('staff_token'\)/);
  assert.match(recorderHtml, /params\.delete\('staff_token'\)/);
  assert.match(recorderHtml, /history\.replaceState/);
  assert.match(recorderHtml, /Authorization: `Bearer \$\{STAFF_TOKEN\}`/);
  assert.match(recorderHtml, /Open Record a Consult from the signed-in Aira dashboard/);
});

test('dashboard may renew recorder access only from an approved parent origin', () => {
  assert.match(recorderHtml, /event\.source !== window\.parent/);
  assert.match(recorderHtml, /ADMIN_ORIGINS\.has\(event\.origin\)/);
  assert.match(recorderHtml, /event\.data\?\.type !== 'aira-recorder-token'/);
  assert.match(recorderHtml, /https:\/\/aira-admin-three\.vercel\.app/);
});

test('training clients handle plain-text auth expiry and network failures as visible errors', () => {
  const matches = serverSource.match(/The training server returned an empty response\./g) || [];
  assert.equal(matches.length, 2);
  assert.match(serverSource, /Could not reach training\. Refresh this dashboard page and try again\./);
  assert.match(serverSource, /const text = await r\.text\(\)/);
  assert.match(serverSource, /if \(!r\.ok\) return \{ ok:false, error:/);
});
