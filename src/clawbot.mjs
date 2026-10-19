// iLink wire format verified against Tencent/openclaw-weixin 2.4.10.
// This optional channel has its own Durable Object, credentials and outbox.
const BASE = 'https://ilinkai.weixin.qq.com';
const DAY = 86400000;
const QUEUE_TTL = 3600000;
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const initial = () => ({ enabled: false, queue: [], seen: {}, sent: 0, lastError: null });
const validText = (value, max = 8192) => typeof value === 'string' && value.length > 0 && value.length <= max;

export function ilinkOrigin(value = BASE) {
  let u;
  try { u = new URL(value); } catch { throw new Error('clawbot_invalid_host'); }
  if (u.protocol !== 'https:' || !/^ilink[a-z0-9-]*\.weixin\.qq\.com$/.test(u.hostname)
      || u.port || u.username || u.password || u.search || u.hash || !['', '/'].includes(u.pathname)) {
    throw new Error('clawbot_invalid_host');
  }
  return u.origin;
}

export function clawbotError(error) {
  const text = String(error?.message || '');
  if (text.includes('Illegal invocation')) return 'clawbot_runtime_binding';
  if (error?.name === 'SyntaxError') return 'clawbot_invalid_response';
  if (error?.name === 'DataCloneError') return 'clawbot_storage_error';
  if (error?.name === 'TypeError') return 'clawbot_network_failed';
  return /^clawbot_[a-z_]+(?:_-?\d+)?$/.test(text) ? text : 'clawbot_unavailable';
}

export function clawbotStatus(s, now = Date.now()) {
  const expiresAt = s.lastInboundAt ? s.lastInboundAt + DAY : null;
  const state = !s.enabled ? 'disabled' : !s.token ? 'needs_login'
    : s.lastError === 'clawbot_login_expired' ? 'needs_login'
    : !s.context || !expiresAt || expiresAt <= now || s.blocked ? 'needs_reply'
    : s.sent >= 10 ? 'quota_exhausted' : s.lastError ? 'error' : 'ready';
  return { enabled: s.enabled, state, expiresAt, remainingEstimate: Math.max(0, 10 - s.sent),
    lastError: s.lastError, pending: s.queue.filter(q => q.expiresAt > now).length,
    lastTest: s.lastTest || null, lastAcceptedAt: s.lastAcceptedAt || null,
    note: '会话约 24 小时、连续约 10 条；额度为本工具估计，微信实际限制为准。接口接受不等于手机已收到。' };
}

export class ClawBot {
  constructor(storage, fetcher = (...args) => fetch(...args), clock = () => Date.now()) {
    this.storage = storage; this.fetcher = fetcher; this.clock = clock;
  }
  async load() { return (await this.storage.get('clawbot')) || initial(); }
  async save(s) { await this.storage.put('clawbot', s); }

  async call(s, path, body, { timeout = 8000, base = s.base || BASE } = {}) {
    let response;
    try {
      response = await this.fetcher(ilinkOrigin(base) + '/ilink/bot/' + path, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'manual', signal: AbortSignal.timeout(timeout),
        headers: { 'Content-Type': 'application/json', 'iLink-App-Id': 'bot',
          'iLink-App-ClientVersion': '132106', AuthorizationType: 'ilink_bot_token',
          'X-WECHAT-UIN': btoa(String(crypto.getRandomValues(new Uint32Array(1))[0])),
          ...(s.token ? { Authorization: `Bearer ${s.token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify({ ...body,
          base_info: { channel_version: '2.4.10', bot_agent: 'DidGPTResetToday/0.2' } }) }),
      });
      if (!response.ok) throw new Error(`clawbot_http_${response.status}`);
      const data = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('clawbot_invalid_response');
      const code = data.ret || data.errcode;
      if (code) {
        if (Number(code) === -14) throw new Error('clawbot_login_expired');
        if (Number(code) === -2) throw new Error('clawbot_reply_required');
        throw new Error('clawbot_rejected');
      }
      if (data.error) throw new Error('clawbot_rejected');
      return data;
    } catch (error) {
      if (['TimeoutError', 'AbortError'].includes(error?.name)) throw new Error('clawbot_timeout');
      throw new Error(clawbotError(error));
    }
  }

  async loginStart() {
    const s = await this.load();
    const data = await this.call({}, 'get_bot_qrcode?bot_type=3', { local_token_list: s.token ? [s.token] : [] });
    if (!validText(data.qrcode) || !validText(data.qrcode_img_content)) throw new Error('clawbot_invalid_response');
    s.login = { id: crypto.randomUUID(), code: data.qrcode, expiresAt: this.clock() + 300000, base: BASE };
    await this.save(s);
    return { id: s.login.id, qrContent: data.qrcode_img_content, expiresAt: s.login.expiresAt };
  }

  async loginPoll(input) {
    let s = await this.load();
    if (!s.login || input.id !== s.login.id || this.clock() >= s.login.expiresAt) return { status: 'expired' };
    if (input.verifyCode !== undefined && !/^\d{4,12}$/.test(input.verifyCode)) throw new Error('clawbot_invalid_verify_code');
    let data;
    try {
      data = await this.call({}, `get_qrcode_status?qrcode=${encodeURIComponent(s.login.code)}`
        + (input.verifyCode ? `&verify_code=${encodeURIComponent(input.verifyCode)}` : ''), undefined, { base: s.login.base });
    } catch (error) { if (error.message === 'clawbot_timeout') return { status: 'wait' }; throw error; }
    if (data.status === 'scaned_but_redirect') {
      s.login.base = ilinkOrigin(`https://${data.redirect_host}`);
      await this.save(s); return { status: 'wait' };
    }
    if (data.status === 'binded_redirect') {
      if (!s.token) throw new Error('clawbot_needs_rebind');
      delete s.login; s.enabled = true; await this.save(s); return { status: 'confirmed' };
    }
    if (data.status === 'confirmed') {
      if (!validText(data.bot_token) || !validText(data.ilink_user_id, 512) || !validText(data.ilink_bot_id, 512)) {
        throw new Error('clawbot_invalid_response');
      }
      // Rebinding never sends pending messages intended for the previous owner.
      s = { ...initial(), enabled: true, token: data.bot_token, user: data.ilink_user_id,
        base: ilinkOrigin(data.baseurl || s.login.base), boundAt: this.clock(), buf: '' };
      await this.save(s); return { status: 'confirmed' };
    }
    if (!['wait', 'scaned', 'expired', 'need_verifycode', 'verify_code_blocked'].includes(data.status)) {
      throw new Error('clawbot_invalid_response');
    }
    return { status: data.status };
  }

  async refresh(s) {
    if (!s.enabled || !s.token || s.lastError === 'clawbot_login_expired') return;
    try {
      const data = await this.call(s, 'getupdates', { get_updates_buf: s.buf || '' });
      if (data.msgs !== undefined && !Array.isArray(data.msgs)) throw new Error('clawbot_invalid_response');
      for (const message of data.msgs || []) {
        const at = message.create_time_ms;
        // Ignore other users, bot echoes, old messages and repeated batches.
        if (message.from_user_id !== s.user || message.message_type !== 1 || !validText(message.context_token)
            || !Number.isFinite(at) || at < s.boundAt || at > this.clock() + 60000 || at <= (s.lastInboundAt || 0)) continue;
        s.context = message.context_token; s.lastInboundAt = Math.min(at, this.clock());
        s.sent = 0; s.blocked = false; s.lastError = null;
      }
      if (typeof data.get_updates_buf === 'string') s.buf = data.get_updates_buf;
      if (['clawbot_timeout', 'clawbot_unavailable'].includes(s.lastError)) s.lastError = null;
    } catch (error) {
      // Empty long polls normally time out. They do not renew the session.
      if (error.message !== 'clawbot_timeout') s.lastError = clawbotError(error);
    }
    await this.save(s);
  }

  async enqueue(items) {
    const s = await this.load();
    if (!s.enabled) return;
    const now = this.clock();
    s.queue = s.queue.filter(q => q.expiresAt > now);
    for (const item of items) {
      if (!validText(item.key, 512) || !validText(item.title, 1024) || !validText(item.content, 50000)
          || !Number.isFinite(item.queuedAt) || item.queuedAt < s.boundAt || item.queuedAt + QUEUE_TTL <= now
          || s.seen[item.key] || s.queue.some(q => q.key === item.key)) continue;
      if (s.queue.length >= 100) throw new Error('clawbot_queue_full');
      s.queue.push({ ...item, id: crypto.randomUUID(), expiresAt: item.queuedAt + QUEUE_TTL, attempts: 0, nextAttempt: 0 });
    }
    await this.save(s);
  }

  async send(s, item) {
    const state = clawbotStatus(s, this.clock()).state;
    if (state === 'needs_login') throw new Error('clawbot_login_expired');
    if (state === 'disabled') throw new Error('clawbot_disabled');
    if (['needs_reply', 'quota_exhausted'].includes(state)) throw new Error('clawbot_reply_required');
    // Reserve a slot before the network call: a timed-out request may have sent.
    s.sent++; await this.save(s);
    try {
      const text = Array.from(`${item.title}\n\n${item.content}`).slice(0, 1700).join('') + '\nData: https://codex-reset.com/';
      const data = await this.call(s, 'sendmessage', { msg: {
        from_user_id: '', to_user_id: s.user, client_id: item.id,
        message_type: 2, message_state: 2, context_token: s.context,
        item_list: [{ type: 1, text_item: { text } }],
      } });
      // iLink can omit the default-zero ret field and return only message_id.
      // An empty/unrelated JSON object still does not establish acceptance.
      const hasMessageId = (typeof data.message_id === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(data.message_id))
        || (typeof data.message_id === 'number' && Number.isFinite(data.message_id) && data.message_id > 0);
      if (data.ret !== 0 && !(data.ret === undefined && hasMessageId)) throw new Error('clawbot_invalid_response');
      s.lastError = null; s.lastAcceptedAt = this.clock();
      // Never claim a device delivery, including when no message_id is returned.
      return { status: 'accepted', at: this.clock() };
    } catch (error) {
      s.lastError = clawbotError(error);
      if (s.lastError === 'clawbot_reply_required') s.blocked = true;
      throw error;
    } finally { await this.save(s); }
  }

  async tick({ paused = false, settings } = {}) {
    const s = await this.load();
    if (!s.enabled) return clawbotStatus(s, this.clock());
    s.queue = s.queue.filter(q => q.expiresAt > this.clock());
    if (settings) {
      const { allowsNotification } = await import('./settings.mjs');
      s.queue = s.queue.filter(q => allowsNotification(q, settings));
    }
    await this.refresh(s);
    if (!paused) {
      // One attempt per tick bounds latency and conserves the small session quota.
      const item = s.queue.find(q => q.nextAttempt <= this.clock());
      if (item && ['ready', 'error'].includes(clawbotStatus(s, this.clock()).state)) {
        item.attempts++; item.nextAttempt = this.clock() + Math.min(1800000, 120000 * 2 ** Math.min(item.attempts - 1, 4));
        await this.save(s);
        try {
          await this.send(s, item);
          s.seen[item.key] = this.clock(); s.queue = s.queue.filter(q => q.key !== item.key);
        } catch { /* Error already recorded; the primary service remains independent. */ }
      }
    }
    for (const [key, at] of Object.entries(s.seen)) if (this.clock() - at > 3 * DAY) delete s.seen[key];
    await this.save(s); return clawbotStatus(s, this.clock());
  }

  async handle(request) {
    try {
      const path = new URL(request.url).pathname;
      let input = {};
      if (request.method === 'POST') {
        const raw = await request.text();
        if (raw.length > (path === '/clawbot/enqueue' ? 200000 : 2048)) return json({ error: 'invalid_request' }, 413);
        try { input = raw ? JSON.parse(raw) : {}; } catch { return json({ error: 'invalid_request' }, 400); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) return json({ error: 'invalid_request' }, 400);
      }
      if (path === '/clawbot/status') return json(clawbotStatus(await this.load(), this.clock()));
      if (path === '/clawbot/login/start') return json(await this.loginStart());
      if (path === '/clawbot/login/poll') return json(await this.loginPoll(input));
      if (path === '/clawbot/disable') { await this.save(initial()); return json({ state: 'disabled' }); }
      if (path === '/clawbot/refresh') {
        const s = await this.load(); await this.refresh(s); return json(clawbotStatus(s, this.clock()));
      }
      if (path === '/clawbot/enqueue') {
        if (!Array.isArray(input.items) || input.items.length > 20) return json({ error: 'invalid_request' }, 400);
        await this.enqueue(input.items); return json({ accepted: true });
      }
      if (path === '/clawbot/tick') return json(await this.tick(input));
      if (path === '/clawbot/test') {
        const s = await this.load();
        if (s.lastTestAttempt && this.clock() - s.lastTestAttempt < 60000) return json({ error: 'test_rate_limited' }, 429);
        s.lastTestAttempt = this.clock(); s.lastTest = null; await this.save(s);
        const result = await this.send(s, { id: crypto.randomUUID(), title: 'GPT今天重置了吗？聊天测试',
          content: '这是一条测试消息，没有发生真实重置。请确认声音、锁屏提示及未读标记是否符合预期。\n会话过期或额度用尽时，请回复一句话恢复聊天提醒。' });
        s.lastTest = result; await this.save(s); return json(result);
      }
      if (path === '/clawbot/confirm-test') {
        const s = await this.load();
        if (s.lastTest?.status !== 'accepted') return json({ error: 'no_accepted_test' }, 409);
        s.lastTest.confirmedByUserAt = this.clock(); await this.save(s); return json({ status: 'confirmed_by_user' });
      }
      return json({ error: 'not_found' }, 404);
    } catch (error) { return json({ error: clawbotError(error) }, 502); }
  }
}
