const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { TRAINING_SCORE_TIMEOUT_MS } = require('../training-limits');

function scorer(create) {
  const source = fs.readFileSync(require.resolve('../ai'), 'utf8');
  const start = source.indexOf('async function scoreTranscript(');
  const end = source.indexOf('\nasync function processRecording(', start);
  const context = {
    anthropic: { messages: { create } }, SCORING_PROMPT: 'Synthetic rubric: ',
    TRAINING_SCORE_TIMEOUT_MS, process: { env: {} },
    console: { log() {}, error() {} }, setTimeout: callback => callback(),
  };
  return vm.runInNewContext(source.slice(start, end) + '\nscoreTranscript;', context);
}

const card = Object.fromEntries([
  'total_score', 'sitdown_score', 'objection_score', 'language_score', 'close_score',
  'ai_summary', 'overall_coaching', 'sitdown_score_explainer',
  'objection_score_explainer', 'language_score_explainer', 'close_score_explainer',
].map(key => [key, key.endsWith('score') ? 80 : 'Synthetic feedback']));

test('slow practice grading uses two minutes without changing model, output cap or retry count', async () => {
  const calls = [];
  const grade = scorer(async (request, options) => {
    calls.push({ request, options });
    // Simulate a provider needing more than the old 45-second deadline.
    if (options.timeout < 65_000) throw new Error('Request timed out.');
    return { content: [{ text: JSON.stringify(card) }] };
  });
  const result = await grade('REP: synthetic conversation', { practice: true });
  assert.equal(result.total_score, 80);
  assert.equal(result.overall_coaching, 'Synthetic feedback');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.timeout, 120_000);
  assert.equal(calls[0].options.maxRetries, 0);
  assert.equal(calls[0].request.model, 'claude-opus-4-5');
  assert.equal(calls[0].request.max_tokens, 4096);
});

test('practice timeout remains one attempt and reports the actual attempt count', async () => {
  let calls = 0;
  const grade = scorer(async () => { calls++; throw new Error('Request timed out.'); });
  await assert.rejects(grade('synthetic', { practice: true }), /after 1 attempt: Request timed out/);
  assert.equal(calls, 1);
});

test('recorded-consultation grading retains its original three attempts', async () => {
  let calls = 0;
  const grade = scorer(async (request, options) => {
    calls++;
    assert.equal(options, undefined);
    throw new Error('synthetic outage');
  });
  await assert.rejects(grade('synthetic recording'), /after 3 attempts/);
  assert.equal(calls, 3);
});

test('in-flight grading retains concurrency beyond the old one-minute release', async () => {
  let now = 0;
  const timers = [];
  const context = {
    module: { exports: {} }, require: createRequire(require.resolve('../training-security')),
    setTimeout(callback, delay) {
      const timer = { callback, due: now + delay, cancelled: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { timer.cancelled = true; },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../training-security'), 'utf8'), context);
  const session = { owner_id: 'staff-a', training_feature: 'game', started_at: Date.now(), messages: Array(4).fill({ role: 'user', content: 'synthetic' }) };
  let reservations = 0;
  const guard = context.module.exports.createTrainingSecurity({
    getSession: () => session, reserveUsage: async () => { reservations++; return { allowed: true }; },
  });
  const response = () => Object.assign(new EventEmitter(), {
    status(code) { this.code = code; return this; }, set() {}, json(body) { this.body = body; return this; },
  });
  const request = body => ({ training: { sub: 'staff-a', features: ['game', 'practice'] }, body });
  const grading = response();
  let providerCalls = 0;
  await guard.action('end')(request({ session_id: 'session-a' }), grading, () => providerCalls++);
  assert.equal(providerCalls, 1);
  assert.equal(timers[0].due, 135_000);
  now = 61_000;
  for (const timer of timers) if (!timer.cancelled && timer.due <= now) timer.callback();
  const blocked = response();
  await guard.action('start')(request({}), blocked, () => providerCalls++);
  assert.equal(blocked.code, 429);
  assert.equal(reservations, 1);
  // A disconnected browser must not free the still-running provider call.
  grading.emit('close');
  const disconnected = response();
  await guard.action('start')(request({}), disconnected, () => providerCalls++);
  assert.equal(disconnected.code, 429);
  grading.emit('finish');
  const allowed = response();
  await guard.action('start')(request({}), allowed, () => providerCalls++);
  assert.equal(providerCalls, 2);
  allowed.emit('finish');
});
