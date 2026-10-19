import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClawBot, clawbotStatus, ilinkOrigin } from '../src/clawbot.mjs';
import worker from '../src/worker.mjs';
import { Monitor } from '../src/monitor.mjs';
import { api } from '../scripts/lib/client.mjs';
import { chatStatusLines } from '../scripts/lib/clawbot.mjs';

const NOW = Date.parse('2026-10-19T02:00:00Z');
function memory() {
  const values = new Map();
  return { async get(key) { return structuredClone(values.get(key)); }, async put(key, value) { values.set(key, structuredClone(value)); } };
}
const reply = (at = NOW) => ({ from_user_id: 'test-user', message_type: 1, create_time_ms: at, context_token: `synthetic-context-${at}` });
const ready = () => ({ enabled: true, token: 'synthetic-bot-credential', user: 'test-user', context: 'synthetic-context',
  boundAt: NOW - 10000, lastInboundAt: NOW - 1000, queue: [], seen: {}, sent: 0, lastError: null });
const item = (key = 'event:completed') => ({ key, title: '重置测试', content: 'Synthetic announcement', stage: 'completed', queuedAt: NOW });
const request = (path, body = {}) => new Request(`https://monitor/clawbot/${path}`, { method: 'POST', body: JSON.stringify(body) });

test('optional channel starts disabled and makes no network calls', async () => {
  const bot = new ClawBot(memory(), () => { throw new Error('must not fetch'); }, () => NOW);
  await bot.enqueue([item()]);
  assert.equal((await bot.tick()).state, 'disabled');
  assert.equal((await bot.load()).queue.length, 0);
});

test('QR binding validates redirects, supports pairing and keeps credentials server-side', async () => {
  const storage = memory();
  const statuses = [
    { status: 'scaned_but_redirect', redirect_host: 'ilinkai2.weixin.qq.com' },
    { status: 'need_verifycode' },
    { status: 'confirmed', bot_token: 'synthetic-new-token', ilink_user_id: 'test-user', ilink_bot_id: 'test-bot', baseurl: 'https://ilinkai2.weixin.qq.com/' },
  ];
  const seen = [];
  const bot = new ClawBot(storage, async (url, options) => {
    seen.push({ url, options });
    if (url.includes('get_bot_qrcode')) return Response.json({ qrcode: 'synthetic-qr', qrcode_img_content: 'https://example.com/synthetic-qr' });
    return Response.json(statuses.shift());
  }, () => NOW);
  const login = await bot.loginStart();
  assert.equal((await bot.loginPoll({ id: 'wrong' })).status, 'expired');
  assert.equal((await bot.loginPoll({ id: login.id })).status, 'wait');
  assert.equal((await bot.loginPoll({ id: login.id })).status, 'need_verifycode');
  assert.deepEqual(await bot.loginPoll({ id: login.id, verifyCode: '123456' }), { status: 'confirmed' });
  assert.ok(seen.at(-1).url.startsWith('https://ilinkai2.weixin.qq.com/'));
  assert.match(seen.at(-1).url, /verify_code=123456/);
  assert.equal(JSON.parse(seen[0].options.body).local_token_list.length, 0);
  const status = JSON.stringify(clawbotStatus(await bot.load(), NOW));
  assert.ok(!status.includes('synthetic-new-token'));
  assert.ok(!status.includes('test-user'));
  assert.equal((await bot.load()).enabled, true);
  assert.equal(clawbotStatus(await bot.load(), NOW).state, 'needs_reply');
  for (const value of ['http://ilinkai.weixin.qq.com', 'https://evil.example', 'https://ilinkai.weixin.qq.com.evil.example',
    'https://ilinkai.weixin.qq.com@evil.example', 'https://ilinkai.weixin.qq.com:8443', 'https://ilinkai.weixin.qq.com/path']) assert.throws(() => ilinkOrigin(value));
});

test('only a new message from the bound owner renews the context and quota', async () => {
  const storage = memory(); await storage.put('clawbot', { ...ready(), sent: 9, blocked: true });
  let messages = [reply(NOW - 5000), { ...reply(), from_user_id: 'someone-else' }, { ...reply(), message_type: 2 }, reply(NOW + 120000)];
  const bot = new ClawBot(storage, async () => Response.json({ ret: 0, msgs: messages, get_updates_buf: 'synthetic-cursor' }), () => NOW);
  await bot.refresh(await bot.load());
  assert.equal((await bot.load()).sent, 9);
  messages = [reply()]; await bot.refresh(await bot.load());
  let state = await bot.load(); assert.equal(state.sent, 0); assert.equal(state.blocked, false);
  state.sent = 4; await bot.save(state); await bot.refresh(await bot.load());
  assert.equal((await bot.load()).sent, 4, 'replayed update must not reset quota');
});

test('24-hour expiry and ten attempts require a user reply; tests use the same quota', async () => {
  const storage = memory(); const bot = new ClawBot(storage, () => { throw new Error('must not fetch'); }, () => NOW);
  for (const state of [{ ...ready(), lastInboundAt: NOW - 86400001 }, { ...ready(), sent: 10 }]) {
    await storage.put('clawbot', state);
    const response = await bot.handle(request('test'));
    assert.equal((await response.json()).error, 'clawbot_reply_required');
  }
  const text = chatStatusLines(clawbotStatus({ ...ready(), sent: 10 }, NOW)).join('\n');
  assert.match(text, /回复/);
});

test('durable chat outbox deduplicates retries and never re-sends accepted messages after restart', async () => {
  const storage = memory(); await storage.put('clawbot', ready()); let sends = 0;
  const fetcher = async (url, options) => {
    if (url.includes('getupdates')) return Response.json({ ret: 0, msgs: [] });
    sends++; const body = JSON.parse(options.body);
    assert.equal(body.msg.to_user_id, 'test-user');
    assert.ok(body.msg.item_list[0].text_item.text.includes('Data: https://codex-reset.com/'));
    assert.equal(options.headers.Authorization, 'Bearer synthetic-bot-credential');
    return Response.json({ ret: 0 });
  };
  let bot = new ClawBot(storage, fetcher, () => NOW);
  await bot.enqueue([item(), item()]); assert.equal((await bot.load()).queue.length, 1);
  await bot.tick(); assert.equal(sends, 1);
  bot = new ClawBot(storage, fetcher, () => NOW + 120000);
  await bot.enqueue([item()]); await bot.tick(); assert.equal(sends, 1);
  assert.equal((await bot.load()).sent, 1);
});

test('chat queue respects pause, preference changes, expiry and disabling', async () => {
  const storage = memory(); await storage.put('clawbot', ready()); let now = NOW; let sends = 0;
  const bot = new ClawBot(storage, async url => {
    if (url.includes('sendmessage')) sends++;
    return Response.json({ ret: 0, msgs: [] });
  }, () => now);
  await bot.enqueue([item(), { ...item('event:planned'), stage: 'planned' }]);
  await bot.tick({ paused: true, settings: { alerts: 'completed', banked: false } });
  assert.equal(sends, 0); assert.equal((await bot.load()).queue.length, 1);
  now += 3600001; await bot.tick(); assert.equal(sends, 0); assert.equal((await bot.load()).queue.length, 0);
  await bot.handle(request('disable')); const saved = await bot.load();
  assert.equal(saved.token, undefined); assert.equal(saved.context, undefined); assert.equal(saved.enabled, false);
});

test('upstream rejection cannot leak secrets; requires a new reply and leaves primary channel independent', async () => {
  const storage = memory(); await storage.put('clawbot', ready());
  const bot = new ClawBot(storage, async () => Response.json({ ret: -2, errmsg: 'synthetic-bot-credential synthetic-context' }), () => NOW);
  const response = await bot.handle(request('test')); const text = await response.text();
  assert.equal(response.status, 502); assert.ok(!text.includes('synthetic'));
  assert.equal((await bot.load()).blocked, true);
  assert.equal(clawbotStatus(await bot.load(), NOW).state, 'needs_reply');
  assert.equal((await bot.load()).lastTest, null);
});

test('empty send response does not count as accepted; device confirmation is explicit', async () => {
  const storage = memory(); await storage.put('clawbot', ready()); let now = NOW, data = {};
  const bot = new ClawBot(storage, async () => Response.json(data), () => now);
  assert.equal((await bot.handle(request('test'))).status, 502);
  assert.equal((await bot.handle(request('confirm-test'))).status, 409);
  data = { ret: 0 }; now += 60001;
  assert.equal((await bot.handle(request('test'))).status, 200);
  assert.equal((await bot.load()).lastTest.confirmedByUserAt, undefined);
  assert.equal((await bot.handle(request('confirm-test'))).status, 200);
  assert.equal((await bot.load()).lastTest.confirmedByUserAt, now);
});

test('message_id without ret is accepted, while an explicit error or invalid ID is never accepted', async () => {
  for (const response of [{ message_id: 'synthetic-message-123' }, { message_id: 123456789 }]) {
    const storage = memory(); await storage.put('clawbot', ready());
    const bot = new ClawBot(storage, async () => Response.json(response), () => NOW);
    assert.equal((await bot.handle(request('test'))).status, 200);
    assert.equal((await bot.load()).lastTest.status, 'accepted');
    assert.equal((await bot.load()).lastTest.confirmedByUserAt, undefined);
  }
  for (const response of [{}, { message_id: '' }, { message_id: {} }, { message_id: 0 },
    { ret: -2, message_id: 'synthetic-message' }, { errcode: -14, message_id: 'synthetic-message' }]) {
    const storage = memory(); await storage.put('clawbot', ready());
    const bot = new ClawBot(storage, async () => Response.json(response), () => NOW);
    assert.equal((await bot.handle(request('test'))).status, 502);
    assert.equal((await bot.load()).lastTest, null);
  }
});

test('optional enqueue failure cannot duplicate primary delivery', async () => {
  const storage = memory(); let now = NOW, secondaryFails = true, primarySends = 0;
  const feed = { stale: false, fetched_at: new Date(now).toISOString(), events: [], tweets: [
    { id: 'synthetic-event', url: 'https://x.com/thsottiaux/status/123456789', at: new Date(now).toISOString(), text: 'We will reset today' },
  ] };
  const monitor = new Monitor(storage, { SOURCE_USER_AGENT: 'test', XTUIS_TOKEN: 'synthetic-token' }, async url => {
    if (url.includes('/api/feed')) return Response.json({ ...feed, fetched_at: new Date(now).toISOString() });
    primarySends++; return new Response('ok');
  }, () => now, async items => { assert.equal(items.length, 1); if (secondaryFails) throw new Error('down'); });
  const baseline = await monitor.load(); baseline.initialized = true; await monitor.save(baseline);
  const first = await monitor.check();
  assert.equal(primarySends, 1); assert.equal(first.clawbotOutbox.length, 1);
  secondaryFails = false; now += 120000;
  const second = await monitor.check(); assert.equal(primarySends, 1); assert.equal(second.clawbotOutbox.length, 0);
});

test('public routes require authentication and cannot call internal enqueue or tick', async () => {
  const env = { ADMIN_TOKEN: 'synthetic-admin-credential-for-testing-only', MONITOR: {
    idFromName(name) { return name; }, get(name) { return { fetch() { return Response.json({ name }); } }; },
  } };
  for (const path of ['status', 'login/start', 'refresh', 'test', 'disable']) {
    const response = await worker.fetch(new Request(`https://example.com/clawbot/${path}`), env);
    assert.equal(response.status, 401);
  }
  const headers = { Authorization: `Bearer ${env.ADMIN_TOKEN}` };
  for (const path of ['enqueue', 'tick']) assert.equal((await worker.fetch(new Request(`https://example.com/clawbot/${path}`, { headers, method: 'POST' }), env)).status, 404);
  assert.equal((await worker.fetch(new Request('https://example.com/clawbot/disable', { headers }), env)).status, 405);
  assert.deepEqual(await (await worker.fetch(new Request('https://example.com/clawbot/status', { headers }), env)).json(), { name: 'personal-clawbot-v1' });
});

test('manager uses GET for optional channel status and provides an upgrade hint for old deployments', async () => {
  const profile = { url: 'https://tibo-wechat-reset-alert.example.workers.dev', admin: 'synthetic-admin' };
  await api(profile, '/clawbot/status', undefined, async (_url, options) => {
    assert.equal(options.method, 'GET'); return Response.json({ state: 'disabled' });
  });
  await assert.rejects(() => api(profile, '/clawbot/status', undefined, async () => Response.json({ error: 'not_found' }, { status: 404 })), /更新云端程序/);
});
