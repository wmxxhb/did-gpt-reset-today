import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashboardModel, calendarMonth, chinaDate, shiftMonth, renderOverview, preserveOverview } from '../web/dashboard.mjs';
import { mergeResetHistory } from '../src/reset-history.mjs';
import { Monitor, FEED_URL } from '../src/monitor.mjs';

const NOW = Date.parse('2026-10-19T04:00:00Z');
const row = (stage, at = '2026-10-19T02:00:00Z', extra = {}) => ({ key: `111:${stage}`, stage, at, url: 'https://x.com/thsottiaux/status/111', ...extra });
const status = (activity = [], extra = {}) => ({ activity, lastSourceSuccess: NOW, sourceError: null, ...extra });

test('today is a Beijing calendar day, not the UTC day or the date of the newest old post', () => {
  assert.equal(chinaDate('2026-10-18T16:00:00Z'), '2026-10-19');
  const old = row('observed', '2026-10-18T15:59:59Z');
  let model = dashboardModel(status([old]), NOW);
  assert.equal(model.title, '今日暂无重置消息'); assert.equal(model.lastReset.at, old.at);
  model = dashboardModel(status([row('observed', '2026-10-18T16:00:00Z')]), NOW);
  assert.equal(model.title, '今日已重置');
});

test('preview upgrades to completed, and another preview never replaces the last completed reset', () => {
  const old = row('observed', '2026-10-17T20:41:01Z', { key: 'old:completed' });
  const preview = row('planned', undefined, { text: 'We will reset today' });
  let model = dashboardModel(status([preview, old]), NOW);
  assert.equal(model.title, '今日将会进行重置'); assert.equal(model.lastReset.key, old.key);
  model = dashboardModel(status([row('completed'), preview, old, row('rolling', '2026-10-19T03:00:00Z')]), NOW);
  assert.equal(model.title, '今日已重置'); assert.equal(model.lastReset.stage, 'completed');
  assert.equal(model.days[model.today].completed.length, 1);
});

test('banked grants, retracted matches and future timestamps do not mark a reset day', () => {
  const model = dashboardModel(status([
    row('banked'), row('completed', undefined, { withdrawn: true }),
    row('observed', '2026-10-20T00:00:00Z'),
    row('observed', undefined, { key: '222:completed' }),
  ], { withdrawnIds: ['222'] }), NOW);
  assert.equal(model.state, 'none'); assert.equal(model.lastReset, null); assert.deepEqual(model.days, {});
});

test('data failures cannot turn absence of current records into a trustworthy no-news conclusion', () => {
  assert.equal(dashboardModel(status([], { sourceError: 'source_stale' }), NOW).state, 'unknown');
  assert.equal(dashboardModel(status([], { lastSourceSuccess: NOW - 1800000 }), NOW).state, 'unknown');
  assert.equal(dashboardModel(status([row('completed')], { sourceError: 'source_stale' }), NOW).state, 'completed');
  assert.equal(dashboardModel(status([]), NOW).state, 'none');
});

test('explicit future-day promises do not claim a reset today; explicit dates can carry a promise across days', () => {
  for (const text of ['We will reset tomorrow', 'Reset next week', 'Reset on 2026-10-20']) {
    const model = dashboardModel(status([row('planned', undefined, { text })]), NOW);
    assert.equal(model.state, 'none', text);
  }
  const model = dashboardModel(status([row('planned', '2026-10-18T04:00:00Z', { text: 'We will reset on 2026-10-19' })]), NOW);
  assert.equal(model.state, 'planned');
});

test('month grid handles leap years, Monday-first weeks and year changes', () => {
  const cells = calendarMonth('2024-02');
  assert.equal(cells[0].date, '2024-01-29'); assert.equal(cells.length % 7, 0);
  assert.equal(cells.filter(cell => cell.inMonth).length, 29);
  assert.ok(cells.some(cell => cell.date === '2024-02-29'));
  assert.equal(shiftMonth('2026-12', 1), '2027-01'); assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('1970-01', -1), '1970-01');
  assert.throws(() => calendarMonth('2026-13'), /无效月份/);
});

test('persistent history deduplicates completion evidence, retains old records and applies retractions', () => {
  const direct = row('completed', undefined, { key: '111:completed' });
  const observed = { ...direct, stage: 'observed' };
  let history = mergeResetHistory([direct], [observed, row('planned'), row('banked')], [], NOW);
  assert.equal(history.length, 1); assert.equal(history[0].stage, 'completed');
  history = mergeResetHistory(history, [], [], NOW + 10 * 86400000);
  assert.equal(history[0].key, direct.key);
  assert.equal(mergeResetHistory(history, [], ['111'], NOW).length, 0);
  assert.ok(!JSON.stringify(history).includes('content'));
});

test('historical completions beyond the 40-row activity window remain in the calendar after feed rotation', async () => {
  let state, time = NOW;
  let feed = { stale: false, fetched_at: new Date(time).toISOString(), tweets: [],
    events: Array.from({ length: 80 }, (_, index) => ({ id: String(1000 + index), group: 'reset', announcement_state: 'announced',
      announced_at: new Date(NOW - index * 86400000).toISOString(), url: `https://x.com/thsottiaux/status/${1000 + index}` })) };
  const storage = { async get() { return state && structuredClone(state); }, async put(_key, value) { state = structuredClone(value); } };
  const monitor = new Monitor(storage, { SOURCE_USER_AGENT: 'synthetic' }, async url => { assert.equal(url, FEED_URL); return Response.json(feed); }, () => time);
  let result = await monitor.check();
  assert.equal(result.activity.length, 40); assert.equal(result.resetHistory.length, 80); assert.equal(result.queue.length, 0);
  time += 120000; feed = { stale: false, fetched_at: new Date(time).toISOString(), tweets: [], events: [] };
  result = await monitor.check(); assert.equal(result.resetHistory.length, 80);
  const model = dashboardModel({ ...result, lastSourceSuccess: result.lastSuccess }, time);
  assert.equal(Object.keys(model.days).length, 80);
  assert.equal(model.lastReset.key, '1000:completed');
});

test('overview keeps last-reset time and calendar but excludes notification controls and the activity list', () => {
  const html = renderOverview(status([row('observed', '2026-10-17T20:41:01Z')]), { now: NOW });
  assert.match(html, /今日暂无重置消息/); assert.match(html, /上次重置时间/); assert.match(html, /2026\/10\/18 04:41/);
  assert.match(html, /重置日历/); assert.match(html, /2026-10-18，已重置/); assert.match(html, /data-calendar-step="-1"/);
  assert.doesNotMatch(html, /通知通道|发送测试|data-toggle|最近动态|channel-grid|activity-list/);
});

test('a selected calendar date shows its own reset evidence without changing the today summary', () => {
  const html = renderOverview(status([row('observed', '2026-10-17T20:41:01Z')]), { now: NOW, month: '2026-10', selectedDay: '2026-10-18' });
  assert.match(html, /今日暂无重置消息/);
  assert.match(html, /data-calendar-day="2026-10-18" aria-pressed="true"/);
  assert.match(html, /<strong>2026-10-18<\/strong> 已重置/);
  const escaped = renderOverview(status([row('observed', undefined, { url: 'https://x.com.evil.example/thsottiaux/status/111' })]), { now: NOW });
  assert.ok(!escaped.includes('evil.example'));
});

test('a temporary cloud connection failure keeps last reset evidence but marks the current day as unknown', () => {
  const old = row('observed', '2026-10-17T20:41:01Z');
  const previous = { connected: true, url: 'https://example.workers.dev', status: status([old]), chat: { state: 'ready' } };
  const cached = preserveOverview(previous, { connected: true, url: previous.url, status: null, error: 'offline' });
  const model = dashboardModel(cached.status, NOW);
  assert.equal(model.state, 'unknown'); assert.equal(model.lastReset.key, old.key);
  assert.equal(cached.error, 'offline'); assert.equal(previous.status.sourceError, null);
  const other = { connected: true, url: 'https://other.example.workers.dev', status: null };
  assert.equal(preserveOverview(previous, other).status, null);
});
