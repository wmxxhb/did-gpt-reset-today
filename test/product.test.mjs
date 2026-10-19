import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Monitor, serviceChannel } from '../src/monitor.mjs';
import { ClawBot } from '../src/clawbot.mjs';
import { ResetMonitor } from '../src/worker.mjs';
import { homeLines, activityLines } from '../scripts/lib/presentation.mjs';
import { newer, latestVersion } from '../scripts/lib/updates.mjs';
import { testNotificationChannels } from '../scripts/lib/notification-tests.mjs';

const NOW = Date.parse('2026-10-19T09:00:00Z');
function memory() {
  const data = new Map();
  return { async get(k) { return structuredClone(data.get(k)); }, async put(k, v) { data.set(k, structuredClone(v)); } };
}
const req = (path, body) => new Request('https://monitor' + path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
const post = id => ({ id, url: `https://x.com/thsottiaux/status/${id}`, at: new Date(NOW).toISOString(), text: 'We have reset usage limits' });
function harness(enabled = false) {
  const storage = memory(); let ids = ['111']; let sourceCalls = 0, serviceCalls = 0; const chat = [];
  let clock = NOW;
  const monitor = new Monitor(storage, { SOURCE_USER_AGENT: 'synthetic', ...(enabled ? { XTUIS_TOKEN: 'synthetic-token' } : {}) }, async url => {
    if (url.includes('/api/feed')) { sourceCalls++; return Response.json({ stale: false, fetched_at: new Date(clock).toISOString(), tweets: ids.map(post), events: [] }); }
    serviceCalls++; return new Response('ok');
  }, () => clock, async items => chat.push(...items));
  return { monitor, storage, chat, setIds(v) { ids = v; clock += 120000; }, calls: () => ({ sourceCalls, serviceCalls }) };
}

test('chat-only deployment never calls service provider and still queues chat notifications', async () => {
  const h = harness(); await h.monitor.check(); h.setIds(['111', '222']);
  const s = await h.monitor.check();
  assert.equal(h.calls().serviceCalls, 0); assert.equal(h.chat.length, 1);
  assert.equal(s.queue.length, 0); assert.equal(s.activity.find(row => row.key === '222:completed').service, 'disabled');
  assert.equal(s.activity.find(row => row.key === '222:completed').url, post('222').url);
});

test('legacy service binding remains enabled until explicitly disabled; reenabling never replays old events', async () => {
  const h = harness(true); await h.monitor.check();
  let s = await h.monitor.load(); assert.equal(serviceChannel(s, { XTUIS_TOKEN: 'synthetic' }).enabled, true);
  s.serviceEnabled = false; await h.monitor.save(s); h.setIds(['111', '222']); await h.monitor.check();
  assert.equal(h.calls().serviceCalls, 0);
  s = await h.monitor.load(); s.serviceEnabled = true; await h.monitor.save(s); h.setIds(['111', '222', '333']);
  await h.monitor.check(); assert.equal(h.calls().serviceCalls, 1);
});

test('pause continues source updates and records new events without notifying or replaying after resume', async () => {
  const h = harness(true); await h.monitor.check();
  let s = await h.monitor.load(); s.paused = true; await h.monitor.save(s);
  h.setIds(['111', '222']); s = await h.monitor.check();
  assert.equal(h.calls().sourceCalls, 2); assert.equal(h.calls().serviceCalls, 0); assert.equal(h.chat.length, 0);
  assert.equal(s.activity.find(row => row.key === '222:completed').service, 'paused');
  s.paused = false; await h.monitor.save(s); h.setIds(['111', '222', '333']); await h.monitor.check();
  assert.equal(h.calls().serviceCalls, 1); assert.equal(h.chat.length, 1);
});

test('initial feed is visible as historical activity while baseline remains silent', async () => {
  const h = harness(true); const s = await h.monitor.check();
  assert.equal(s.activity.length, 1); assert.equal(s.activity[0].service, 'historical');
  assert.equal(h.calls().serviceCalls, 0); assert.equal(h.chat.length, 0);
});

test('completion replaces the headline when a post upgrades without changing its publication time', async () => {
  const storage = memory(); let now = NOW, complete = false;
  const monitor = new Monitor(storage, { SOURCE_USER_AGENT: 'synthetic', XTUIS_TOKEN: 'synthetic' }, async url => {
    if (!url.includes('/api/feed')) return new Response('ok');
    return Response.json({ stale: false, fetched_at: new Date(now).toISOString(), events: [],
      tweets: [{ ...post('111'), text: complete ? 'We have reset usage limits' : 'We will reset today' }] });
  }, () => now);
  await monitor.check(); complete = true; now += 120000;
  const s = await monitor.check();
  assert.equal(s.activity[0].stage, 'completed');
  assert.match(homeLines({ ...s, lastSourceSuccess: s.lastSuccess }, { state: 'disabled', enabled: false }, now).join('\n'), /宣布重置完成/);
});

test('service toggle validates config, immediately discards pending service notices and leaves chat intact', async () => {
  const storage = memory(); const object = new ResetMonitor({ storage }, { XTUIS_TOKEN: 'synthetic-token' });
  const s = await object.monitor.load(); s.queue = [{ key: 'waiting', title: 'synthetic', attempts: 0, nextAttempt: 0 }];
  s.clawbotOutbox = [{ key: 'chat-waiting' }]; await object.monitor.save(s);
  assert.equal((await object.fetch(req('/channels', { serviceEnabled: false }))).status, 200);
  const saved = await object.monitor.load(); assert.equal(saved.queue.length, 0); assert.equal(saved.clawbotOutbox.length, 1);
  assert.equal((await object.fetch(req('/test', {}))).status, 409);
  assert.equal((await object.fetch(req('/channels', { serviceEnabled: true }))).status, 200);
  assert.equal((await object.fetch(req('/channels', { serviceEnabled: 'false' }))).status, 400);
  const noBinding = new ResetMonitor({ storage: memory() }, {});
  assert.equal((await noBinding.fetch(req('/channels', { serviceEnabled: true }))).status, 409);
  assert.equal((await noBinding.fetch(req('/channels', { serviceEnabled: false }))).status, 200);
});

test('chat toggle preserves credentials and never sends notifications queued before reenabling', async () => {
  const storage = memory(); let now = NOW;
  const bot = new ClawBot(storage, () => { throw new Error('must not fetch'); }, () => now);
  await bot.save({ enabled: true, token: 'synthetic', user: 'synthetic', boundAt: NOW - 1000, queue: [{ key: 'old' }], seen: {}, sent: 0 });
  const toggle = enabled => bot.handle(req('/clawbot/toggle', { enabled }));
  await toggle(false); assert.equal((await bot.load()).token, 'synthetic'); assert.equal((await bot.load()).queue.length, 0);
  now += 120000; await toggle(true);
  await bot.enqueue([{ key: 'old', title: 'old', content: 'old', queuedAt: NOW }]);
  assert.equal((await bot.load()).queue.length, 0);
  assert.equal((await bot.load()).enabled, true);
});

test('outdated scheduled policy cannot undo a new pause or restore filtered queue', async () => {
  const storage = memory(); const bot = new ClawBot(storage, async () => Response.json({ ret: 0, msgs: [] }), () => NOW);
  const s = { enabled: true, token: 'synthetic', queue: [{ key: 'test', expiresAt: NOW + 60000 }], seen: {}, sent: 0 };
  await bot.policy(s, { paused: true, revision: 2 }); await bot.save(s);
  await bot.tick({ paused: false, revision: 1 });
  assert.equal((await bot.load()).paused, true); assert.equal((await bot.load()).queue.length, 0);
});

test('a new owner reply gets one recovery acknowledgement without marking reset delivery confirmed', async () => {
  const storage = memory(); let sends = 0;
  const bot = new ClawBot(storage, async url => {
    if (url.includes('sendmessage')) { sends++; return Response.json({ message_id: 'synthetic-reply-id' }); }
    return Response.json({ ret: 0, msgs: [{ from_user_id: 'owner', message_type: 1, create_time_ms: NOW, context_token: 'synthetic-context' }] });
  }, () => NOW);
  await bot.save({ enabled: true, token: 'synthetic', user: 'owner', boundAt: NOW - 1000, queue: [], seen: {}, sent: 0 });
  await bot.tick(); await bot.tick();
  assert.equal(sends, 1); assert.equal((await bot.load()).sent, 1);
  assert.equal((await bot.load()).lastTest, undefined);
});

test('home differentiates no news from stale data and presents no-notification mode truthfully', () => {
  const s = { initialized: true, lastSourceSuccess: NOW, service: { enabled: false, configured: false }, activity: [] };
  const chat = { enabled: false, state: 'disabled' };
  assert.match(homeLines(s, chat, NOW).join('\n'), /暂未发现新的重置消息/);
  assert.match(homeLines(s, chat, NOW).join('\n'), /仅查看动态/);
  const stale = homeLines({ ...s, sourceError: 'source_stale' }, chat, NOW).join('\n');
  assert.match(stale, /暂时无法确认/); assert.doesNotMatch(stale, /今天不会重置/);
  const expired = homeLines(s, { enabled: true, state: 'needs_reply' }, NOW).join('\n');
  assert.match(expired, /没有已确认可用的通知通道/); assert.match(expired, /回复任意内容/);
});

test('activity explains filtering and distinguishes upstream acceptance from actual phone receipt', () => {
  const lines = activityLines({ activity: [{ key: 'a', at: new Date(NOW).toISOString(), title: '预告', service: 'filtered' },
    { key: 'b', at: new Date(NOW).toISOString(), title: '完成', service: 'accepted' }] }, { recent: [{ key: 'b', status: 'accepted' }] }).join('\n');
  assert.match(lines, /提醒范围未选中/); assert.match(lines, /接口已接受/); assert.match(lines, /不代表手机实际送达/);
});

test('notification test offers only enabled channels and can exit when both are disabled', async () => {
  for (const enabled of [true, false]) {
    let prompted = false; const calls = [];
    const ui = { async choose(_title, options, fallback) { prompted = true; assert.equal(options[1], undefined); assert.equal(options[3], undefined); assert.equal(fallback, '2'); return '0'; } };
    const api = async path => { calls.push(path); return path === '/status' ? { service: { enabled: false } } : { enabled, state: enabled ? 'ready' : 'disabled' }; };
    await testNotificationChannels(ui, api); assert.equal(prompted, enabled); assert.equal(calls.length, 2);
  }
});

test('version checker pins package lookup to a verified commit and never includes account credentials', async () => {
  const sha = 'a'.repeat(40); const requests = [];
  const result = await latestVersion(async (url, options) => {
    requests.push(url); assert.equal(options.headers?.Authorization, undefined);
    return Response.json(url.includes('commits') ? { sha } : { name: 'did-gpt-reset-today', version: '0.2.0' });
  });
  assert.equal(result.sha, sha); assert.ok(requests[1].includes('/' + sha + '/'));
  assert.equal(newer('0.2.0', '0.1.0'), true); assert.equal(newer('0.2.0', '0.2.0'), false);
  assert.equal(newer('0.2.0', '0.10.0'), false);
  await assert.rejects(() => latestVersion(async () => Response.json({ sha: '../bad' })), /更新信息无效/);
});
