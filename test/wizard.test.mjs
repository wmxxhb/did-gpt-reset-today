import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { api, deploymentUrl, workerUrl, statusLines } from '../scripts/lib/client.mjs';
import { saveProfile, loadProfile } from '../scripts/lib/profile.mjs';
import { allowsNotification, normalizeSettings } from '../src/settings.mjs';
import { Monitor } from '../src/monitor.mjs';
import { ResetMonitor } from '../src/worker.mjs';

function memory() {
  let state;
  return { async get() { return state && structuredClone(state); }, async put(_key, value) { state = structuredClone(value); } };
}

test('wizard identifies the deployed Worker URL without guessing an account URL', () => {
  const lines = [
    JSON.stringify({ type: 'other', targets: ['https://wrong.example'] }),
    JSON.stringify({ type: 'deploy', targets: ['schedule: */2 * * * *', 'https://tibo-wechat-reset-alert.example.workers.dev'] }),
  ].join('\n');
  assert.equal(deploymentUrl(lines), 'https://tibo-wechat-reset-alert.example.workers.dev');
  assert.equal(deploymentUrl(JSON.stringify({ type: 'deploy', targets: ['https://evil.example'] })), null);
  assert.equal(workerUrl('https://example.workers.dev'), 'https://tibo-wechat-reset-alert.example.workers.dev');
  assert.equal(workerUrl('https://tibo-wechat-reset-alert.example.workers.dev/test'), 'https://tibo-wechat-reset-alert.example.workers.dev');
  for (const u of ['http://example.workers.dev', 'https://evil.example', 'https://user:password@example.workers.dev', 'https://example.workers.dev?token=secret']) {
    assert.throws(() => workerUrl(u));
  }
});

test('menu client fills the URL, auth and JSON without exposing credentials in errors', async () => {
  const profile = { url: 'https://tibo-wechat-reset-alert.example.workers.dev', admin: 'test-secret' };
  const data = await api(profile, '/settings', { alerts: 'completed', banked: false }, async (url, options) => {
    assert.equal(url, profile.url + '/settings');
    assert.equal(options.headers.Authorization, 'Bearer test-secret');
    assert.equal(options.method, 'POST');
    assert.equal(JSON.parse(options.body).alerts, 'completed');
    return Response.json({ ok: true });
  });
  assert.equal(data.ok, true);
  await assert.rejects(() => api(profile, '/test', {}, async () => Response.json({ error: 'test_rate_limited' }, { status: 429 })), /一分钟/);
  await assert.rejects(() => api(profile, '/status', undefined, async () => { throw new Error('test-secret'); }), error => !error.message.includes('test-secret'));
});

test('alert presets preserve the existing default and separate banked resets', () => {
  assert.deepEqual(normalizeSettings(), { alerts: 'all', banked: true });
  assert.equal(allowsNotification({ stage: 'planned' }, { alerts: 'both', banked: false }), true);
  assert.equal(allowsNotification({ stage: 'rolling' }, { alerts: 'both', banked: false }), false);
  assert.equal(allowsNotification({ stage: 'planned' }, { alerts: 'completed', banked: true }), false);
  assert.equal(allowsNotification({ stage: 'observed' }, { alerts: 'completed', banked: false }), true);
  assert.equal(allowsNotification({ stage: 'banked' }, { alerts: 'completed', banked: true }), true);
  for (const value of [null, false, {}, { alerts: 'wrong', banked: false }, { alerts: 'both', banked: 'yes' }]) assert.throws(() => normalizeSettings(value));
});

test('changing settings discards excluded queued notices and prevents replay', async () => {
  const storage = memory();
  const object = new ResetMonitor({ storage }, {});
  const state = await object.monitor.load();
  state.queue = [
    { key: 'test:planned', stage: 'planned' },
    { key: 'test:completed', stage: 'completed' },
  ];
  await object.monitor.save(state);
  const response = await object.fetch(new Request('https://monitor/settings', {
    method: 'POST', body: JSON.stringify({ alerts: 'completed', banked: false }),
  }));
  assert.equal(response.status, 200);
  const saved = await object.monitor.load();
  assert.equal(saved.queue.length, 1); assert.equal(saved.queue[0].stage, 'completed');
  assert.ok(saved.seen['test:planned']);
  const invalid = await object.fetch(new Request('https://monitor/settings', { method: 'POST', body: 'null' }));
  assert.equal(invalid.status, 400);
  assert.equal((await object.monitor.load()).settings.alerts, 'completed');
});

test('test confirmation requires an accepted test and persists the explicit user response', async () => {
  const object = new ResetMonitor({ storage: memory() }, {});
  assert.equal((await object.fetch(new Request('https://monitor/confirm-test', { method: 'POST' }))).status, 409);
  const state = await object.monitor.load();
  state.lastTestResult = { status: 'accepted' }; await object.monitor.save(state);
  assert.equal((await object.fetch(new Request('https://monitor/confirm-test', { method: 'POST' }))).status, 200);
  assert.ok((await object.monitor.load()).lastTestResult.confirmedByUserAt);
  assert.equal((await object.fetch(new Request('https://monitor/reset-test', { method: 'POST' }))).status, 200);
  assert.equal((await object.monitor.load()).lastTestResult, null);
  assert.equal((await object.fetch(new Request('https://monitor/confirm-test', { method: 'POST' }))).status, 409);
});

test('newly excluded posts are consumed silently rather than replayed after a mode change', async () => {
  const storage = memory();
  const now = Date.parse('2026-10-18T08:00:00Z');
  const monitor = new Monitor(storage, { SOURCE_USER_AGENT: 'test' }, async () => Response.json({
    stale: false, fetched_at: new Date(now).toISOString(), events: [],
    tweets: [{ id: '2111492738025959922', url: 'https://x.com/thsottiaux/status/2111492738025959922', at: new Date(now).toISOString(), text: 'We will reset today' }],
  }), () => now);
  const state = await monitor.load(); state.initialized = true; state.settings = { alerts: 'completed', banked: false }; await monitor.save(state);
  const result = await monitor.check();
  assert.equal(result.queue.length, 0); assert.ok(result.seen['2111492738025959922:planned']);
});

test('status is readable and never calls HTTP acceptance a phone delivery', () => {
  const lines = statusLines({ initialized: true, paused: false, lastSourceSuccess: Date.now(), pending: [], settings: { alerts: 'both', banked: false }, lastTestResult: { status: 'accepted' } });
  assert.match(lines[0], /运行正常/); assert.match(lines[3], /尚未确认/);
  assert.match(statusLines({ initialized: true, lastSourceSuccess: Date.now() - 3600000, pending: [] })[0], /超过 15 分钟/);
});

test('Windows profile survives save/reload while remaining encrypted on disk', { skip: process.platform !== 'win32' }, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'tibo-wizard-test-'));
  try {
    const profile = { url: 'https://tibo-wechat-reset-alert.example.workers.dev', admin: 'synthetic-test-key-你好', contact: '你好@example.com' };
    await saveProfile(folder, profile);
    assert.deepEqual(await loadProfile(folder), profile);
    const encrypted = await readFile(join(folder, '.tibo-local', 'profile.dat'), 'utf8');
    assert.ok(!encrypted.includes(profile.admin)); assert.ok(!encrypted.includes(profile.url));
    profile.admin = 'another-synthetic-key'; await saveProfile(folder, profile);
    assert.deepEqual(await loadProfile(folder), profile);
  } finally {
    assert.ok(resolve(folder).startsWith(resolve(join(tmpdir(), 'tibo-wizard-test-'))));
    await rm(folder, { recursive: true, force: true });
  }
});
