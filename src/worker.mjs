import { Monitor, pushMessage, safeError, serviceChannel } from './monitor.mjs';
import { normalizeSettings, allowsNotification } from './settings.mjs';
import { ClawBot } from './clawbot.mjs';
import { VERSION } from './version.mjs';

const botStub = env => env.MONITOR.get(env.MONITOR.idFromName('personal-clawbot-v1'));
const BOT_ROUTES = ['/clawbot/status', '/clawbot/login/start', '/clawbot/login/poll',
  '/clawbot/refresh', '/clawbot/test', '/clawbot/confirm-test', '/clawbot/disable', '/clawbot/toggle'];

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });

// A single SQLite-backed Durable Object owns the outbox and serializes all checks.
export class ResetMonitor {
  constructor(ctx, env) {
    this.storage = ctx.storage;
    this.monitor = new Monitor(ctx.storage, env, undefined, undefined, env.MONITOR ? async items => {
      const result = await botStub(env).fetch('https://monitor/clawbot/enqueue', {
        method: 'POST', body: JSON.stringify({ items }),
      });
      if (!result.ok) throw new Error('clawbot_enqueue_failed');
    } : null);
    this.clawbot = new ClawBot(ctx.storage);
    this.env = env;
    this.tail = Promise.resolve();
  }
  fetch(request) {
    const task = this.tail.then(() => this.handle(request));
    this.tail = task.catch(() => {});
    return task;
  }
  async savePolicy(state) {
    state.policyRevision = (state.policyRevision || 0) + 1;
    await this.monitor.save(state);
    if (this.env.MONITOR) {
      try {
        const result = await botStub(this.env).fetch('https://monitor/clawbot/policy', { method: 'POST',
          body: JSON.stringify({ paused: state.paused, settings: normalizeSettings(state.settings), revision: state.policyRevision }) });
        if (!result.ok) return false;
      } catch { return false; }
    }
    return true;
  }
  async handle(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/clawbot/')) return this.clawbot.handle(request);
    if (path === '/check') {
      const state = await this.monitor.check();
      return json(publicStatus(state, this.env));
    }
    if (path === '/status') return json(publicStatus(await this.monitor.load(), this.env));
    if (path === '/channels') {
      const state = await this.monitor.load();
      if (request.method === 'GET') return json({ service: serviceChannel(state, this.env) });
      let input;
      try { const raw = await request.text(); if (raw.length > 1024) throw new Error(); input = JSON.parse(raw); }
      catch { return json({ error: 'invalid_channels' }, 400); }
      if (!input || typeof input.serviceEnabled !== 'boolean') return json({ error: 'invalid_channels' }, 400);
      if (input.serviceEnabled && !serviceChannel(state, this.env).configured) return json({ error: 'service_not_configured' }, 409);
      state.serviceEnabled = input.serviceEnabled;
      if (!state.serviceEnabled) {
        for (const item of state.queue) {
          state.seen[item.key] = Date.now();
          const row = state.activity?.find(row => row.key === item.key); if (row) row.service = 'disabled';
        }
        state.queue = [];
      }
      await this.monitor.save(state); return json({ service: serviceChannel(state, this.env) });
    }
    if (path === '/settings') {
      const state = await this.monitor.load();
      if (request.method === 'GET') return json(normalizeSettings(state.settings));
      try {
        const body = await request.text();
        if (body.length > 2048) return json({ error: 'invalid_settings' }, 400);
        state.settings = normalizeSettings(JSON.parse(body));
      } catch { return json({ error: 'invalid_settings', hint: '请选择预告和完成、仅完成或全部进度，并设置可储备重置开关。' }, 400); }
      for (const item of state.queue) if (!allowsNotification(item, state.settings)) state.seen[item.key] = Date.now();
      for (const row of state.activity || []) if (state.queue.some(q => q.key === row.key) && !allowsNotification(row, state.settings)) row.service = 'filtered';
      state.queue = state.queue.filter(item => allowsNotification(item, state.settings));
      state.clawbotOutbox = (state.clawbotOutbox || []).filter(item => allowsNotification(item, state.settings));
      if (!(await this.savePolicy(state))) return json({ error: 'policy_sync_failed' }, 503);
      return json(state.settings);
    }
    if (path === '/confirm-test') {
      const state = await this.monitor.load();
      if (state.lastTestResult?.status !== 'accepted') return json({ error: 'no_accepted_test' }, 409);
      state.lastTestResult.confirmedByUserAt = Date.now();
      await this.monitor.save(state);
      return json({ status: 'confirmed_by_user' });
    }
    if (path === '/reset-test') {
      const state = await this.monitor.load();
      state.lastTestResult = null;
      state.lastTest = null;
      await this.monitor.save(state);
      return json({ status: 'needs_verification' });
    }
    if (path === '/pause' || path === '/resume') {
      const state = await this.monitor.load();
      state.paused = path === '/pause';
      if (state.paused) {
        for (const item of state.queue) {
          state.seen[item.key] = Date.now();
          const row = state.activity?.find(row => row.key === item.key); if (row) row.service = 'paused';
        }
        state.queue = []; state.clawbotOutbox = [];
      }
      if (!(await this.savePolicy(state))) return json({ error: 'policy_sync_failed' }, 503);
      return json(publicStatus(state, this.env));
    }
    if (path === '/test') {
      const state = await this.monitor.load();
      if (state.serviceEnabled === false) return json({ error: 'service_disabled' }, 409);
      if (state.lastTest && Date.now() - state.lastTest < 60000) return json({ error: 'test_rate_limited' }, 429);
      state.lastTest = Date.now();
      await this.monitor.save(state);
      try {
        const receipt = await pushMessage(this.env, {
          title: 'GPT今天重置了吗？测试',
          content: '这是一条测试消息，没有发生真实重置。\n收到这条消息后，微信通知通道才算验证完成。',
        });
        state.lastTestResult = { status: 'accepted', receipt, at: Date.now() };
        await this.monitor.save(state);
        return json({ status: 'accepted', receipt, note: '推送服务 HTTP 已接收；请在手机微信确认是否实际收到。' });
      } catch (error) {
        const reason = safeError(error);
        state.lastTestResult = { status: 'failed', reason, at: Date.now() };
        await this.monitor.save(state);
        return json({ error: 'push_test_failed', reason, hint: errorHint(reason) }, 502);
      }
    }
    return json({ error: 'not_found' }, 404);
  }
}

function publicStatus(s, env) {
  return {
    version: VERSION, service: serviceChannel(s, env), activity: s.activity || [], policyRevision: s.policyRevision || 0,
    initialized: s.initialized, paused: s.paused,
    lastCheck: s.lastCheck, lastSourceSuccess: s.lastSuccess, sourceError: s.lastError,
    consecutiveSourceFailures: s.failures, nextFetch: s.nextFetch,
    lastTestResult: s.lastTestResult || null,
    settings: normalizeSettings(s.settings),
    pending: s.queue.map(q => ({ title: q.title, attempts: q.attempts, nextAttempt: q.nextAttempt, error: q.lastError || null })),
    recentSubmissions: s.receipts,
    clawbotEnqueueError: s.clawbotError || null,
    note: 'accepted 仅表示推送服务已接收，不代表手机已收到。Data: https://codex-reset.com/',
  };
}

function errorHint(reason) {
  if (reason === 'missing_xtuis_token') return '请设置 XTUIS_TOKEN，填写公众号给出的 token。';
  if (reason === 'xtuis_token_format_invalid') return 'XTUIS_TOKEN 应只填写 token，不是完整网址，也不要附加空格、标题或其他文字。';
  if (reason === 'unsupported_push_provider') return 'PUSH_PROVIDER 应填写 xtuis 或 pushplus。';
  if (reason === 'xtuis_provider_rejected' || reason.startsWith('xtuis_code_')) return '虾推啥拒绝了请求，请核对 token、关注状态与服务额度。';
  if (reason === 'http_429') return '推送服务限流，请稍后重试。';
  if (reason === 'network_timeout' || reason === 'network_connection_failed') return '云端连接推送服务失败，请稍后重试。';
  if (reason.startsWith('http_') || reason === 'xtuis_response_html') return '推送服务返回异常响应，请检查服务可用性与访问限制。';
  return '推送通道异常；请保留错误代码以便排查，不要提供 token。';
}

async function authorized(request, token) {
  if (!token || token.length < 32) return false;
  const expected = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`Bearer ${token}`));
  const actual = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(request.headers.get('Authorization') || ''));
  const a = new Uint8Array(expected), b = new Uint8Array(actual);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export default {
  async scheduled(_event, env, ctx) {
    const stub = env.MONITOR.get(env.MONITOR.idFromName('personal-monitor-v1'));
    ctx.waitUntil(stub.fetch('https://monitor/check', { method: 'POST' }).then(async r => {
      if (!r.ok) throw new Error('monitor_check_failed');
      const status = await r.json();
      if (status.sourceError || status.pending.some(q => q.error)) {
        console.error(JSON.stringify({ sourceError: status.sourceError, pending: status.pending.length }));
      }
      const bot = await botStub(env).fetch('https://monitor/clawbot/tick', {
        method: 'POST', body: JSON.stringify({ paused: status.paused, settings: status.settings, revision: status.policyRevision }),
      });
      if (!bot.ok) console.error('clawbot_tick_failed');
    }));
  },
  async fetch(request, env) {
    if (!(await authorized(request, env.ADMIN_TOKEN))) return json({ error: 'unauthorized' }, 401);
    const path = new URL(request.url).pathname;
    if (!['/status', '/channels', '/check', '/test', '/pause', '/resume', '/settings', '/confirm-test', '/reset-test', ...BOT_ROUTES].includes(path)) return json({ error: 'not_found' }, 404);
    const allowed = ['/status', '/clawbot/status'].includes(path) ? ['GET'] : ['/settings', '/channels'].includes(path) ? ['GET', 'POST'] : ['POST'];
    if (!allowed.includes(request.method)) return json({ error: 'method_not_allowed' }, 405);
    if (BOT_ROUTES.includes(path)) return botStub(env).fetch(request);
    return env.MONITOR.get(env.MONITOR.idFromName('personal-monitor-v1')).fetch(request);
  },
};
