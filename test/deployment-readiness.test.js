const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createReadinessHandler } = require('../deployment-readiness');

for (const runtime of ['22.23.4', '22.23.3']) {
  test(`readiness gates the actual runtime ${runtime} without provider calls`, async () => {
    const app = express();
    app.get('/health/ready', createReadinessHandler({ runtime, expected: '22.23.4', revision: 'abcdef0123456789' }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/health/ready`);
      assert.equal(response.status, runtime === '22.23.4' ? 200 : 503);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { status: runtime === '22.23.4' ? 'ok' : 'unavailable', runtime: { node: runtime }, version: 'abcdef012345' });
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
}
