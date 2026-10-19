import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testNotificationChannels } from '../scripts/lib/notification-tests.mjs';

function setup(answers, { state = 'ready', serviceFails = false, refreshFails = false } = {}) {
  const calls = [], prompts = [];
  const ui = { async choose(title, options, fallback) {
    prompts.push({ title, options, fallback });
    assert.ok(answers.length, 'unexpected question');
    return answers.shift();
  } };
  const api = async path => {
    calls.push(path);
    if (path === '/clawbot/status') return { enabled: state !== 'disabled', state, pending: 0, remainingEstimate: 8 };
    if (path === '/clawbot/refresh') {
      if (refreshFails) throw new Error('temporary connection failure');
      return { enabled: state !== 'disabled', state };
    }
    if (path === '/test' && serviceFails) throw new Error('service unavailable');
    return { status: 'accepted' };
  };
  return { ui, api, calls, prompts };
}

test('chat-only test refreshes replies and never sends or confirms a service message', async () => {
  const s = setup(['2', '1']);
  assert.deepEqual(await testNotificationChannels(s.ui, s.api), [{ channel: '2', confirmed: true }]);
  assert.deepEqual(s.calls, ['/status', '/clawbot/status', '/clawbot/refresh', '/clawbot/test', '/clawbot/confirm-test']);
  assert.equal(s.prompts[0].fallback, '3');
});

test('service-only selection never sends a chat message', async () => {
  const s = setup(['1', '1']);
  await testNotificationChannels(s.ui, s.api);
  assert.deepEqual(s.calls, ['/status', '/clawbot/status', '/test', '/confirm-test']);
});

test('both-channel test confirms each independently and still tests chat when service fails', async () => {
  const s = setup(['3', '1'], { serviceFails: true });
  const results = await testNotificationChannels(s.ui, s.api);
  assert.equal(results[0].confirmed, false); assert.equal(results[1].confirmed, true);
  assert.ok(!s.calls.includes('/confirm-test')); assert.ok(s.calls.includes('/clawbot/confirm-test'));
});

test('receiving the service test never marks a failed chat test as received', async () => {
  const s = setup(['3', '1'], { refreshFails: true });
  const results = await testNotificationChannels(s.ui, s.api);
  assert.equal(results[0].confirmed, true); assert.equal(results[1].confirmed, false);
  assert.ok(!s.calls.includes('/clawbot/test')); assert.ok(!s.calls.includes('/clawbot/confirm-test'));
});

test('disabled or expired chat gives an actionable error without consuming send quota', async () => {
  for (const state of ['disabled', 'needs_login', 'needs_reply', 'quota_exhausted']) {
    const s = setup(['2'], { state });
    const results = await testNotificationChannels(s.ui, s.api);
    assert.equal(results[0].confirmed, false);
    assert.ok(!s.calls.includes('/clawbot/test'));
  }
});

test('cancel sends nothing and not-received answer does not confirm the chat test', async () => {
  const cancelled = setup(['0']);
  assert.deepEqual(await testNotificationChannels(cancelled.ui, cancelled.api), []);
  assert.deepEqual(cancelled.calls, ['/status', '/clawbot/status']);
  const unconfirmed = setup(['2', '0']);
  assert.equal((await testNotificationChannels(unconfirmed.ui, unconfirmed.api))[0].confirmed, false);
  assert.ok(!unconfirmed.calls.includes('/clawbot/confirm-test'));
});
