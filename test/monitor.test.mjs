import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Monitor, FEED_URL, pushMessage } from '../src/monitor.mjs';
import { classifyText, buildNotifications } from '../src/classify.mjs';
import worker, { ResetMonitor } from '../src/worker.mjs';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const TIME = Date.parse('2026-10-18T02:00:00Z');
const POST_ID = '2111492738025959922';
const url = id => `https://x.com/thsottiaux/status/${id}`;
const post = (text, id = POST_ID, at = TIME) => ({ id, url: url(id), text, at: new Date(at).toISOString() });
const feed = (tweets = [], events = [], now = TIME) => ({
  fetched_at: new Date(now).toISOString(), stale: false, tweets, events,
});

function harness() {
  let saved;
  let time = TIME;
  let current = feed();
  let sourceFailure = false;
  let pushFailure = false;
  let pushCalls = 0;
  let sourceCalls = 0;
  const messages = [];
  const storage = {
    async get() { return saved && structuredClone(saved); },
    async put(_key, value) { saved = structuredClone(value); },
  };
  const fetcher = async (requestUrl, options) => {
    if (requestUrl === FEED_URL) {
      sourceCalls++;
      if (sourceFailure) return new Response('', { status: 429, headers: { 'Retry-After': '600' } });
      return Response.json(current);
    }
    pushCalls++;
    messages.push(JSON.parse(options.body));
    return Response.json(pushFailure ? { code: 905 } : { code: 200, data: 'receipt-' + pushCalls });
  };
  const env = { PUSHPLUS_TOKEN: 'secret-token', SOURCE_USER_AGENT: 'test/1.0 (+mailto:test@example.com)' };
  const monitor = new Monitor(storage, env, fetcher, () => time);
  return { monitor, storage, env, fetcher, messages,
    advance(ms = 120000) { time += ms; current.fetched_at = new Date(time).toISOString(); },
    setFeed(f) { current = f; }, setSourceFailure(v) { sourceFailure = v; }, setPushFailure(v) { pushFailure = v; },
    counts() { return { sourceCalls, pushCalls }; },
  };
}

test('original text distinguishes preview, rollout, completion and uncertainty', () => {
  for (const text of ["We will reset everyone's limits today", 'Global reset by EOD.', 'Day 13/ Le limit reset', 'Reset will land tomorrow']) {
    assert.equal(classifyText(text), 'planned', text);
  }
  assert.equal(classifyText('Reset propagating now'), 'rolling');
  assert.equal(classifyText('Reset propagating in the next hour'), 'planned');
  for (const text of ['We have reset usage limits', "I've reset usage limits", 'The reset has been processed.', "What would you like with your side of reset? It's done.", 'Put the reset in the bag. All propagated.']) {
    assert.equal(classifyText(text), 'completed', text);
  }
  for (const text of ["We won't reset today", 'Maybe we will reset today', 'I hope we reset today', 'No reset today', 'The reset has been postponed', 'More effective usage from better caching', "I'm going to reset my password today"]) {
    assert.equal(classifyText(text), null, text);
  }
  assert.equal(classifyText('Landing sometime today by EOD PST', true), 'planned');
  assert.equal(classifyText('Landing sometime today by EOD PST', false), null);
});

test('baseline is silent; a later promise and completion each notify exactly once in normal runs', async () => {
  const h = harness();
  h.setFeed(feed([post('We have reset usage limits')]));
  assert.equal((await h.monitor.check()).initialized, true);
  assert.equal(h.messages.length, 0);
  h.advance();
  h.setFeed(feed([post('We will reset today', '2111492738025959923', TIME + 60000)], [], TIME + 120000));
  await h.monitor.check();
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0].title, /预告/);
  h.advance(); await h.monitor.check();
  assert.equal(h.messages.length, 1);
  h.advance();
  h.setFeed(feed([post('We have reset usage limits', '2111492738025959924', TIME + 300000)], [], TIME + 360000));
  const s = await h.monitor.check();
  assert.equal(h.messages.length, 2);
  assert.match(h.messages[1].title, /完成/);
  assert.equal(s.receipts[0].status, 'accepted');
});

test('same event ID upgrades from preview to tracker-observed completion', async () => {
  const h = harness();
  const event = { id: POST_ID, group: 'reset', announcement_state: 'none', announced_at: new Date(TIME).toISOString(), url: url(POST_ID), summary: 'Landing later today' };
  h.setFeed(feed([post('Global reset by EOD')], [event]));
  await h.monitor.check();
  h.advance();
  h.setFeed(feed([post('Global reset by EOD')], [{ ...event, announcement_state: 'announced' }], TIME + 120000));
  await h.monitor.check();
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0].title, /监测站/);
  h.advance(); await h.monitor.check();
  assert.equal(h.messages.length, 1);
});

test('source schema changes and stale data never generate reset alerts', async () => {
  const h = harness(); await h.monitor.check(); h.advance();
  h.setFeed({ ...feed([post('We have reset usage limits')], [], TIME + 120000), stale: true });
  assert.equal((await h.monitor.check()).lastError, 'source_stale');
  assert.equal(h.messages.length, 0);
  h.advance(240000); h.setFeed({ fetched_at: new Date(TIME + 360000).toISOString(), stale: false });
  assert.equal((await h.monitor.check()).lastError, 'source_schema_changed');
});

test('429 Retry-After and source freshness are respected', async () => {
  const h = harness(); await h.monitor.check(); h.advance(); h.setSourceFailure(true);
  let s = await h.monitor.check();
  assert.equal(s.nextFetch, TIME + 120000 + 600000);
  const calls = h.counts().sourceCalls;
  h.advance(); await h.monitor.check();
  assert.equal(h.counts().sourceCalls, calls);
});

test('failed push remains durable across restart and retries with backoff', async () => {
  const h = harness(); await h.monitor.check(); h.advance();
  h.setFeed(feed([post('We will reset today')], [], TIME + 120000)); h.setPushFailure(true);
  let s = await h.monitor.check();
  assert.equal(s.queue.length, 1); assert.equal(s.receipts.length, 0);
  assert.equal(s.queue[0].lastError, 'pushplus_code_905');
  assert.equal(h.counts().pushCalls, 1);
  await h.monitor.check(); assert.equal(h.counts().pushCalls, 1);
  h.advance(); h.setPushFailure(false);
  const restarted = new Monitor(h.storage, h.env, h.fetcher, () => TIME + 240000);
  s = await restarted.check();
  assert.equal(s.queue.length, 0); assert.equal(s.receipts.length, 1);
  assert.equal(h.counts().pushCalls, 2);
});

test('direct completion beats third-party record for the same ID; banked stays separate', () => {
  const e = { id: POST_ID, group: 'reset', announcement_state: 'announced', announced_at: new Date(TIME).toISOString() };
  const n = buildNotifications(feed([post('We have reset usage limits')], [e]));
  assert.equal(n.length, 1); assert.equal(n[0].stage, 'completed');
  const banked = buildNotifications(feed([{ ...post('We will give one banked reset today'), banked_state: 'announced' }]));
  assert.equal(banked[0].stage, 'banked'); assert.match(banked[0].content, /不等于额度已自动恢复/);
});

test('older than catch-up window is not pushed; non-Tibo source URL is ignored', async () => {
  const h = harness(); await h.monitor.check(); h.advance();
  h.setFeed(feed([post('We have reset usage limits', POST_ID, TIME - 80 * 3600000)], [], TIME + 120000));
  await h.monitor.check(); assert.equal(h.messages.length, 0);
  assert.equal(buildNotifications(feed([{ ...post('We have reset usage limits'), url: 'https://evil.example/' }])).length, 0);
});

test('admin routes deny missing secret, require auth and enforce method', async () => {
  const env = { ADMIN_TOKEN: 'a'.repeat(32) };
  assert.equal((await worker.fetch(new Request('https://app/status'), env)).status, 401);
  assert.equal((await worker.fetch(new Request('https://app/check', { headers: { Authorization: 'Bearer ' + env.ADMIN_TOKEN } }), env)).status, 405);
  assert.equal((await worker.fetch(new Request('https://app/status?token=' + env.ADMIN_TOKEN), env)).status, 401);
});

test('Durable Object serializes overlapping checks', async () => {
  const h = harness();
  const object = new ResetMonitor({ storage: h.storage }, h.env);
  let active = 0, maxActive = 0;
  object.monitor.check = async () => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 15));
    active--; return object.monitor.load();
  };
  await Promise.all([object.fetch(new Request('https://monitor/check')), object.fetch(new Request('https://monitor/check'))]);
  assert.equal(maxActive, 1);
});

test('Xtuis sends form POST and treats msg_id as an asynchronous receipt', async () => {
  let calls = 0;
  const receipt = await pushMessage({ XTUIS_TOKEN: 'test-token' }, { title: '预告重置', content: '测试原文 & 中文' }, async (u, opts) => {
    calls++;
    assert.equal(u, 'https://wx.xtuis.cn/test-token.send');
    assert.equal(opts.method, 'POST');
    assert.match(opts.headers['Content-Type'], /^application\/x-www-form-urlencoded/);
    const form = new URLSearchParams(opts.body);
    assert.equal(form.get('text'), '预告重置');
    assert.equal(form.get('desp'), '测试原文 & 中文');
    return Response.json({ msg_id: 'wx_test_receipt' });
  });
  assert.equal(receipt, 'wx_test_receipt'); assert.equal(calls, 1);
});

test('Xtuis rejects explicit business errors even on HTTP 200', async () => {
  await assert.rejects(() => pushMessage({ PUSH_PROVIDER: 'xtuis', XTUIS_TOKEN: 'test' }, { title: 'test', content: 'test' },
    async () => Response.json({ error: 'invalid token' })), /xtuis_provider_rejected/);
});

test('provider selection validates credentials and preserves existing pushplus setups', async () => {
  await assert.rejects(() => pushMessage({ PUSH_PROVIDER: 'xtuis' }, {}), /missing_xtuis_token/);
  await assert.rejects(() => pushMessage({ PUSH_PROVIDER: 'unknown' }, {}), /unsupported_push_provider/);
  const result = await pushMessage({ PUSHPLUS_TOKEN: 'legacy' }, { title: 'test', content: 'test' }, async (u, opts) => {
    assert.equal(u, 'https://www.pushplus.plus/send');
    assert.equal(JSON.parse(opts.body).token, 'legacy');
    return Response.json({ code: 200, data: 'legacy-receipt' });
  });
  assert.equal(result, 'legacy-receipt');
});

test('Xtuis HTTP 429 exposes Retry-After without leaking endpoint token', async () => {
  await assert.rejects(() => pushMessage({ XTUIS_TOKEN: 'private-value' }, { title: 'test', content: 'test' },
    async () => new Response('', { status: 429, headers: { 'Retry-After': '600' } })), e => {
      assert.equal(e.message, 'http_429'); assert.equal(e.retryAfterMs, 600000);
      assert.ok(!e.message.includes('private-value')); return true;
    });
});

test('Xtuis accepts text or JSON without inventing a missing receipt', async () => {
  for (const response of [new Response('Message queued'), new Response(''), Response.json({ code: 200, message: 'queued' })]) {
    const result = await pushMessage({ PUSH_PROVIDER: ' xtuis\n', XTUIS_TOKEN: ' test-token\n' }, { title: 'test', content: 'test' }, async () => response);
    assert.equal(result, null);
  }
  const nested = await pushMessage({ XTUIS_TOKEN: 'test' }, { title: 'test', content: 'test' }, async () => Response.json({ data: { msg_id: 'wx_nested' } }));
  assert.equal(nested, 'wx_nested');
});

test('Xtuis rejects malformed credentials and HTML error pages', async () => {
  await assert.rejects(() => pushMessage({ XTUIS_TOKEN: 'https://wx.xtuis.cn/example.send' }, {}), /xtuis_token_format_invalid/);
  await assert.rejects(() => pushMessage({ XTUIS_TOKEN: 'test' }, { title: 'test', content: 'test' }, async () => new Response('<!DOCTYPE html><html>Blocked</html>')), /xtuis_response_html/);
});

test('test endpoint persists sanitized error details without returning secrets', async () => {
  const h = harness();
  const object = new ResetMonitor({ storage: h.storage }, { PUSH_PROVIDER: 'xtuis', XTUIS_TOKEN: 'test-secret' });
  const mockedFetch = mock.method(globalThis, 'fetch', async () => { throw new Error('failed URL https://wx.xtuis.cn/test-secret.send'); });
  try {
    const response = await object.fetch(new Request('https://monitor/test', { method: 'POST' }));
    assert.equal(response.status, 502);
    const data = await response.json();
    assert.equal(data.reason, 'network_connection_failed');
    assert.ok(!JSON.stringify(data).includes('test-secret'));
    assert.equal((await object.monitor.load()).lastTestResult.reason, data.reason);
  } finally { mockedFetch.mock.restore(); }
});

test('test endpoint reports HTTP acceptance without a receipt as acceptance only', async () => {
  const h = harness();
  const object = new ResetMonitor({ storage: h.storage }, { XTUIS_TOKEN: 'test-secret' });
  const mockedFetch = mock.method(globalThis, 'fetch', async () => new Response('queued'));
  try {
    const response = await object.fetch(new Request('https://monitor/test', { method: 'POST' }));
    const data = await response.json();
    assert.equal(response.status, 200); assert.equal(data.status, 'accepted'); assert.equal(data.receipt, null);
    assert.equal((await object.monitor.load()).lastTestResult.status, 'accepted');
  } finally { mockedFetch.mock.restore(); }
});
