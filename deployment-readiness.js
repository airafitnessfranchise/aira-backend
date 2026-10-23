function createReadinessHandler({
  runtime = process.versions.node,
  expected = require('./package.json').engines.node,
  revision = process.env.RAILWAY_GIT_COMMIT_SHA || '',
} = {}) {
  // server.js only starts listening after its existing database/startup sequence.
  return (req, res) => {
    const ready = runtime === expected;
    res.set('Cache-Control', 'no-store');
    return res.status(ready ? 200 : 503).json({
      status: ready ? 'ok' : 'unavailable',
      runtime: { node: runtime },
      version: revision.slice(0, 12) || null,
    });
  };
}

module.exports = { createReadinessHandler };
