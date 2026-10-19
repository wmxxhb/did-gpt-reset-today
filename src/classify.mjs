const SOURCE = 'https://codex-reset.com/';
const TITLE = {
  planned: 'Tibo：预告重置',
  rolling: 'Tibo：重置正在发放',
  completed: 'Tibo：宣布重置完成',
  observed: '监测站：记录到重置',
  banked: '可储备重置：有新消息',
};

export function chinaTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date) + '（北京时间）';
}

function sourceLink(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && ['x.com', 'twitter.com'].includes(u.hostname)
      && /^\/thsottiaux\/status\/\d+\/?$/.test(u.pathname) ? u.href : null;
  } catch { return null; }
}

// Classify English original text. A translation must never turn a promise into completion.
export function classifyText(text, context = false) {
  const t = String(text).replace(/https?:\/\/\S+/g, '').replace(/[’‘]/g, "'").toLowerCase();
  if (/\b(password|router|factory reset|reset my pc|reset my computer)\b/.test(t)) return null;
  if (/\b(no|not|never|won't|will not|isn't|aren't|haven't|hasn't|didn't|don't|doesn't|cannot|can't)\b.{0,45}\breset|\breset\b.{0,35}\b(cancelled|canceled|postponed|delayed)\b/.test(t)) return null;
  if (/\b(if|might|maybe|perhaps|hopefully|hope|wish)\b/.test(t)
      || /(?:^|\n)\s*(should we|would you|could we)\b/.test(t)) return null;
  const reset = /\bresets?\b/.test(t);
  if (!reset && !context) return null;
  const future = /\b(will|going to|later|tomorrow|by eod|by end of|next \d+|next hour|next few|within|in (?:the )?(?:next )?(?:\d+|an?|one|two) (?:hours?|minutes?))\b/.test(t);
  const progress = /\b(propagating|rolling out|being (?:reset|processed)|in progress|loading|landing)\b/.test(t);
  if (future) return 'planned';
  if (progress) return 'rolling';
  if (/\b(have|has|had|been|was|were|i've|we've)\b.{0,25}\breset\b|\breset\b.{0,20}\b(completed|processed|done|applied)\b|\b(all propagated|it's done|it is done|done and dusted|has landed|have landed|confirmed landed|i reset|we reset)\b/.test(t)) return 'completed';
  if (reset && (/\b(today|by eod|we'll|i'll)\b/.test(t) || /\bday \d+\s*\//.test(t))) return 'planned';
  return null;
}

function notification(id, stage, text, at, url, evidence) {
  const caveat = stage === 'observed'
    ? '这是第三方监测站的记录，不代表已核验你的账号。'
    : stage === 'completed'
      ? '这是 Tibo 的完成声明；你的账号是否到账，请查看额度页面。'
      : stage === 'banked'
        ? '可储备重置需要按产品提示手动使用，不等于额度已自动恢复。'
        : '这是预告或发放进度，尚不能据此认定已到账。';
  return {
    // A source upgrade from preview to completion must produce a second alert.
    key: `${id}:${stage === 'observed' ? 'completed' : stage}`,
    id, stage, at, title: TITLE[stage], url, text: String(text).slice(0, 3500), evidence,
    content: [String(text).slice(0, 3500), '', `发布时间：${chinaTime(at)}`, evidence, '', caveat,
      '原帖中的 today/tomorrow 按作者当地语境理解，不自动当作北京时间今天。',
      url ? `原帖：${url}` : '本条无直接原帖链接，请核对监测站记录。',
      `Data: ${SOURCE}`].join('\n'),
  };
}

export function buildNotifications(feed) {
  if (!Array.isArray(feed.tweets) || !Array.isArray(feed.events)) throw new Error('source_schema_changed');
  const result = new Map();
  const eventById = new Map(feed.events.map(e => [String(e.id), e]));
  for (const post of feed.tweets) {
    const url = sourceLink(post.url);
    if (!url || !post.id || !Number.isFinite(Date.parse(post.at)) || typeof post.text !== 'string') continue;
    const e = eventById.get(String(post.id));
    const banked = /\bbanked\s+reset\b/i.test(post.text) || post.banked_state;
    if (banked) {
      if (classifyText(post.text, true) || ['announced', 'arriving', 'available'].includes(post.banked_state)) {
        const n = notification(post.id + ':banked', 'banked', post.text, post.at, url, `Tibo 原帖；状态：${post.banked_state || '见原文'}`);
        // Announced/arriving/available are distinct stages for a banked grant.
        n.key += ':' + (post.banked_state || 'announcement');
        result.set(n.key, n);
      }
      continue;
    }
    const stage = classifyText(post.text, e?.group === 'reset');
    if (stage) {
      const n = notification(post.id, stage, post.text, post.at, url, '依据：Tibo 原帖文字（经第三方接口转发）');
      result.set(n.key, n);
    }
  }
  for (const event of feed.events) {
    if (!event.id || !Number.isFinite(Date.parse(event.announced_at))) continue;
    if (event.group !== 'reset' || event.announcement_state !== 'announced') continue;
    const n = notification(event.id, 'observed', event.summary || '', event.announced_at,
      sourceLink(event.url), '依据：第三方监测站将此事件标记为 announced');
    // Prefer a direct completion statement over a tracker record for the same post.
    if (!result.has(n.key)) result.set(n.key, n);
  }
  return [...result.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
