import { buildNotifications } from './classify.mjs';
import { allowsNotification } from './settings.mjs';

export const FEED_URL = 'https://codex-reset.com/api/feed?locale=zh';
export const PUSH_URL = 'https://www.pushplus.plus/send';

export async function getResponse(fetcher, url, options = {}) {
  let response;
  try {
    response = await fetcher(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(20000) });
  } catch (error) {
    // Fetch exception messages can include a URL containing the recipient token.
    throw new Error(['TimeoutError', 'AbortError'].includes(error?.name) ? 'network_timeout' : 'network_connection_failed');
  }
  if (!response.ok) {
    const error = new Error(`http_${response.status}`);
    const seconds = Number(response.headers.get('retry-after'));
    const date = Date.parse(response.headers.get('retry-after'));
    error.retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000
      : Number.isFinite(date) ? Math.max(60000, date - Date.now()) : 120000;
    throw error;
  }
  return response;
}

export async function getJson(fetcher, url, options = {}) {
  const response = await getResponse(fetcher, url, options);
  try { return await response.json(); } catch { throw new Error('response_not_json'); }
}

export function pushProvider(env) {
  const value = String(env.PUSH_PROVIDER || (env.XTUIS_TOKEN ? 'xtuis' : 'pushplus')).trim().toLowerCase();
  if (!['xtuis', 'pushplus'].includes(value)) throw new Error('unsupported_push_provider');
  return value;
}

export async function pushMessage(env, item, fetcher = fetch) {
  const provider = pushProvider(env);
  if (provider === 'xtuis') {
    const token = String(env.XTUIS_TOKEN || '').trim();
    if (!token) throw new Error('missing_xtuis_token');
    if (/\s|[/:?#]/.test(token)) throw new Error('xtuis_token_format_invalid');
    const response = await getResponse(fetcher, `https://wx.xtuis.cn/${encodeURIComponent(token)}.send`, {
      method: 'POST', headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        'Accept': 'application/json, text/plain, */*', 'User-Agent': 'TiboWechatReset/0.1',
      },
      body: new URLSearchParams({ text: item.title, desp: item.content }).toString(),
    });
    const body = (await response.text()).trim();
    if (/^\s*<(?:!doctype|html|head|body)/i.test(body)) throw new Error('xtuis_response_html');
    let data;
    try { data = JSON.parse(body); } catch { /* Official CLI also accepts text/empty 2xx responses. */ }
    if (data && typeof data === 'object') {
      if (data.success === false || data.ok === false || data.error) throw new Error('xtuis_provider_rejected');
      if (data.code != null && /^-?\d+$/.test(String(data.code)) && ![0, 200, 202].includes(Number(data.code))) {
        throw new Error(`xtuis_code_${Number(data.code)}`);
      }
      const id = data.msg_id || data.data?.msg_id;
      if (typeof id === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(id)) return id;
    }
    // As with the provider's own CLI, 2xx only confirms HTTP acceptance.
    // Never invent a provider receipt when its response doesn't contain one.
    return null;
  }
  if (provider !== 'pushplus') throw new Error('unsupported_push_provider');
  if (!env.PUSHPLUS_TOKEN) throw new Error('missing_pushplus_token');
  const data = await getJson(fetcher, PUSH_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: env.PUSHPLUS_TOKEN, title: item.title, content: item.content,
      template: 'txt', channel: env.PUSHPLUS_CHANNEL || 'wechat',
      ...(env.PUSHPLUS_OPTION ? { option: env.PUSHPLUS_OPTION } : {}),
    }),
  });
  if (data.code !== 200 || typeof data.data !== 'string' || !data.data) {
    // Do not log provider error strings: some APIs echo submitted credentials.
    throw new Error(`pushplus_code_${Number(data.code) || 'invalid'}`);
  }
  // code=200 means queued, never "delivered to phone".
  return data.data;
}

export function emptyState() {
  return { version: 1, initialized: false, paused: false, seen: {}, queue: [], receipts: [],
    lastCheck: null, lastSuccess: null, lastError: null, failures: 0, nextFetch: 0 };
}

export function serviceChannel(s, env) {
  const configured = !!(env.PUSH_PROVIDER === 'pushplus' ? env.PUSHPLUS_TOKEN
    : env.PUSH_PROVIDER === 'xtuis' ? env.XTUIS_TOKEN : env.XTUIS_TOKEN || env.PUSHPLUS_TOKEN);
  return { enabled: s.serviceEnabled ?? configured, configured,
    lastTest: s.lastTestResult || null, pending: s.queue.length,
    error: s.queue.find(q => q.lastError)?.lastError || (s.lastTestResult?.status === 'failed' ? s.lastTestResult.reason : null) };
}

function activity(s, item, status) {
  s.activity ||= [];
  let row = s.activity.find(row => row.key === item.key);
  if (!row) {
    row = { key: item.key, stage: item.stage, title: item.title, at: item.at, url: item.url || null,
      text: item.text || '', evidence: item.evidence || '' };
    s.activity.push(row);
  } else {
    Object.assign(row, { stage: item.stage, title: item.title, at: item.at,
      url: item.url || null, text: item.text || '', evidence: item.evidence || '' });
  }
  if (status) row.service = status;
  const stages = { planned: 1, rolling: 2, observed: 3, completed: 4, banked: 0 };
  s.activity.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || stages[b.stage] - stages[a.stage]);
  s.activity = s.activity.slice(0, 40);
  return row;
}

export function safeError(error) {
  const m = String(error?.message || 'unknown_error');
  return /^(http_\d+|source_[a-z_]+|missing_[a-z_]+|pushplus_code_[a-z0-9_]+|xtuis_[a-z_]+|xtuis_code_-?\d+|unsupported_push_provider|network_timeout|network_connection_failed|response_not_json)$/.test(m) ? m : 'network_or_runtime_error';
}

export class Monitor {
  constructor(storage, env, fetcher = fetch, clock = () => Date.now(), secondary = null) {
    this.storage = storage; this.env = env; this.fetcher = fetcher; this.clock = clock;
    this.secondary = secondary;
  }
  async load() { return (await this.storage.get('state')) || emptyState(); }
  async save(state) { await this.storage.put('state', state); }
  async check() {
    const s = await this.load();
    const now = this.clock();
    s.lastCheck = now;
    if (now >= s.nextFetch) {
      try {
        if (!this.env.SOURCE_USER_AGENT) throw new Error('missing_source_user_agent');
        const feed = await getJson(this.fetcher, FEED_URL, { headers: { 'User-Agent': this.env.SOURCE_USER_AGENT } });
        if (feed.stale !== false || !Number.isFinite(Date.parse(feed.fetched_at))
            || now - Date.parse(feed.fetched_at) > 15 * 60000
            || Date.parse(feed.fetched_at) > now + 5 * 60000) throw new Error('source_stale');
        const items = buildNotifications(feed);
        const currentIds = new Set(feed.tweets.map(post => String(post.id)));
        const recognizedIds = new Set(items.map(item => String(item.id).split(':')[0]));
        // Keep the audit row, but retract previously classified chatter when the
        // same source post is present and no longer qualifies as a reset signal.
        const withdrawn = new Set(s.withdrawnIds || []);
        const candidates = [...(s.activity || []), ...s.queue, ...(s.clawbotOutbox || [])];
        for (const item of candidates) {
          const id = item.key.split(':')[0];
          if (currentIds.has(id) && !recognizedIds.has(id)) withdrawn.add(id);
        }
        for (const id of recognizedIds) withdrawn.delete(id);
        for (const row of s.activity || []) row.withdrawn = withdrawn.has(row.key.split(':')[0]);
        s.queue = s.queue.filter(item => !withdrawn.has(item.key.split(':')[0]));
        s.clawbotOutbox = (s.clawbotOutbox || []).filter(item => !withdrawn.has(item.key.split(':')[0]));
        s.withdrawnIds = [...withdrawn].slice(-80);
        const hours = Number(this.env.MAX_AGE_HOURS || 72);
        if (!Number.isFinite(hours) || hours < 1 || hours > 168) throw new Error('source_invalid_max_age');
        for (const item of items) {
          if (Date.parse(item.at) > now + 300000) continue;
          const existing = s.activity?.some(row => row.key === item.key);
          activity(s, item, existing ? undefined : 'historical');
          if (s.seen[item.key] || s.queue.some(q => q.key === item.key)) continue;
          if (!allowsNotification(item, s.settings)) { activity(s, item, 'filtered'); s.seen[item.key] = now; continue; }
          const age = now - Date.parse(item.at);
          if (!s.initialized || age > hours * 3600000 || age < -300000) {
            s.seen[item.key] = now;
            continue;
          }
          if (s.paused) { activity(s, item, 'paused'); s.seen[item.key] = now; continue; }
          if (serviceChannel(s, this.env).enabled) {
            s.queue.push({ ...item, attempts: 0, nextAttempt: now }); activity(s, item, 'queued');
          } else { activity(s, item, 'disabled'); s.seen[item.key] = now; }
          if (this.secondary) (s.clawbotOutbox ||= []).push({ ...item, queuedAt: now });
        }
        s.initialized = true;
        s.lastSuccess = now; s.lastError = null; s.failures = 0;
        // Even authenticated manual checks respect the upstream rate limit.
        s.nextFetch = now + 60000;
      } catch (e) {
        s.failures++;
        s.lastError = safeError(e);
        s.nextFetch = now + Math.max(e.retryAfterMs || 0, Math.min(3600000, 120000 * 2 ** Math.min(s.failures - 1, 5)));
      }
    }
    // Persist the outbox before sending so fetch failures/restarts don't lose alerts.
    await this.save(s);
    let sent = 0;
    for (const item of [...s.queue]) {
      if (s.paused || !serviceChannel(s, this.env).enabled) {
        activity(s, item, s.paused ? 'paused' : 'disabled'); s.seen[item.key] = now;
        s.queue = s.queue.filter(q => q.key !== item.key); continue;
      }
      if (!allowsNotification(item, s.settings)) {
        s.seen[item.key] = now; activity(s, item, 'filtered');
        s.queue = s.queue.filter(q => q.key !== item.key);
        continue;
      }
      if (sent >= 3 || now < item.nextAttempt) continue;
      try {
        // Mark an attempt first. In an ambiguous timeout/crash, retry later: delivery is at least once.
        item.attempts++;
        item.nextAttempt = now + Math.min(21600000, 120000 * 2 ** Math.min(item.attempts - 1, 7));
        await this.save(s);
        const receipt = await pushMessage(this.env, item, this.fetcher);
        s.seen[item.key] = now; activity(s, item, 'accepted');
        s.receipts.unshift({ key: item.key, title: item.title, acceptedAt: now, receipt, status: 'accepted' });
        s.receipts = s.receipts.slice(0, 50);
        s.queue = s.queue.filter(q => q.key !== item.key);
        sent++;
      } catch (e) {
        activity(s, item, 'failed');
        item.lastError = safeError(e);
        if (e.retryAfterMs) item.nextAttempt = Math.max(item.nextAttempt, now + e.retryAfterMs);
        // Stop this batch on failure to avoid repeatedly hitting a blocked provider.
        await this.save(s);
        break;
      }
      await this.save(s);
    }
    // Keep 90 days of dedupe markers, much longer than the 72-hour catch-up window.
    for (const [key, time] of Object.entries(s.seen)) if (now - time > 90 * 86400000) delete s.seen[key];
    await this.save(s);
    if (this.secondary) {
      s.clawbotOutbox = (s.clawbotOutbox || []).filter(item => !s.paused && now - item.queuedAt < 3600000 && allowsNotification(item, s.settings));
      const batch = s.clawbotOutbox.slice(0, 20);
      if (batch.length) {
        try {
          await this.secondary(batch);
          s.clawbotOutbox.splice(0, batch.length); s.clawbotError = null;
        } catch { s.clawbotError = 'clawbot_enqueue_failed'; }
      }
      await this.save(s);
    }
    return s;
  }
}
