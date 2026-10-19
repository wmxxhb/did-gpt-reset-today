const $ = selector => document.querySelector(selector);
const h = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = name => `<svg class="icon" aria-hidden="true"><use href="/icons.svg#${name}"/></svg>`;
const time = value => value && Number.isFinite(new Date(value).getTime()) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '尚未更新';
const external = value => { try { const u = new URL(value); return u.protocol === 'https:' && ['x.com', 'twitter.com', 'github.com', 'dash.cloudflare.com', 'xtuis.cn', 'www.pushplus.plus', 'nodejs.org'].includes(u.hostname) ? h(u.href) : ''; } catch { return ''; } };
const link = (value, label = '查看原帖') => external(value) ? `<a href="${external(value)}" target="_blank" rel="noreferrer">${label}${icon('arrow-up-right')}</a>` : '';
const button = (action, label, name, type = '') => `<button class="button ${type}" data-action="${action}">${name ? icon(name) : ''}${label}</button>`;
let data = null, page = 'home', latestError = '', job = null, activePrompt = '', toastTimer, pending = false, polling = false, connectionReady = false;
const pageScroll = new Map();
const titles = { home: '概览', activity: '最近动态', notifications: '通知设置', more: '更多' };
const chatLabels = { disabled: '已关闭', needs_login: '需要重新扫码', needs_reply: '请回复 ClawBot 一句话', quota_exhausted: '请回复 ClawBot 一句话续期', ready: '可用', error: '连接异常，请刷新' };
const outcomes = { historical: '历史记录，不补发', filtered: '提醒范围未选中', paused: '通知已暂停', disabled: '通道关闭', queued: '等待发送', accepted: '接口已接受', failed: '发送失败，自动重试', expired: '已过期，不补发', withdrawn: '记录已更正，不再发送' };

async function request(path, body) {
  const res = await fetch('/api/' + path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await res.json(); if (!res.ok) throw new Error(result.error || '操作未完成，请重试。'); return result;
}
function toast(text) { clearTimeout(toastTimer); $('#toast').textContent = text; $('#toast').hidden = false; toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6500); }
function setBusy(value) { pending = value; $('#refresh').disabled = value; $('#refresh .icon').classList.toggle('busy', value); }
async function reload(check = false) {
  setBusy(true);
  try { if (check && data?.connected) await request('request', { path: '/check', body: {} }); data = await request('overview');
    if (data.status && !data.status.service) { data.needsCloudUpdate = true; data.status.service = { enabled: true, configured: true, lastTest: data.status.lastTestResult }; }
    latestError = data.error || ''; render(); }
  catch (error) { latestError = error.message; render(); }
  finally { setBusy(false); }
}
function switchControl(channel, enabled, label) { return `<button class="switch" role="switch" aria-checked="${!!enabled}" aria-label="${label}" data-toggle="${channel}"></button>`; }
function heading(title, subtitle = '', action = '') { return `<div class="page-heading"><div><h2>${title}</h2>${subtitle ? `<p class="subheading">${subtitle}</p>` : ''}</div>${action}</div>`; }
function warnings(s, c) {
  const result = [];
  if (data.needsCloudUpdate) result.push(`<div class="notice info">${icon('download')}<span>已连接早期云端版本，请在“更多 → 检查更新”升级后使用独立通知开关。</span></div>`);
  if (data.setupPending) result.push(`<div class="notice info">${icon('circle-help')}<span>上次开通还没有完成，已保存进度。</span>${button('continue', '继续设置')}</div>`);
  if (s.paused) result.push(`<div class="notice info">${icon('pause')}<span>通知已暂停，动态仍会更新。恢复后不补发暂停期间的消息。</span>${button('resume', '恢复通知')}</div>`);
  if (c?.enabled && ['needs_reply', 'quota_exhausted'].includes(c.state)) result.push(`<div class="notice">${icon('message-circle')}<span>在微信给 ClawBot 回复一句话，约两分钟内自动恢复。${s.service.enabled && s.service.configured ? '服务号仍可接收提醒。' : '聊天会话恢复后才能继续提醒。'}</span>${button('chat-refresh', '我已回复')}</div>`);
  if (!s.lastSourceSuccess || Date.now() - s.lastSourceSuccess > 900000 || s.sourceError) result.push(`<div class="notice">${icon('triangle-alert')}<span>暂时无法确认最新情况，请稍后刷新。下方保留历史记录及消息时间。</span></div>`);
  if (s.clawbotEnqueueError) result.push(`<div class="notice">${icon('triangle-alert')}<span>聊天消息转交异常，系统会重试；可在“更多”查看诊断。</span></div>`);
  return result.join('');
}
function channelCard(kind) {
  const s = data.status, c = data.chat;
  const chat = kind === 'chat', info = chat ? c : s.service;
  const enabled = !!info?.enabled, configured = !!info?.configured;
  const healthy = chat ? c?.state === 'ready' : enabled && configured && !info?.error;
  const unknown = !info;
  const status = unknown ? '暂时无法读取状态' : !enabled ? '已关闭' : chat ? chatLabels[c.state] || '状态未知'
    : !configured ? '尚未绑定' : info.error ? '发送异常，请测试检查' : '可用';
  const confirmed = info?.lastTest?.confirmedByUserAt;
  return `<section class="card channel"><div class="channel-top"><div class="channel-icon ${chat ? 'chat' : ''}">${icon(chat ? 'message-circle' : 'bell')}</div><div><h3>${chat ? '聊天提醒' : '服务号提醒'}</h3></div>${unknown ? '' : switchControl(kind, enabled, chat ? '聊天提醒开关' : '服务号提醒开关')}</div>
    <div class="channel-status"><span class="dot ${healthy ? '' : enabled ? 'warning' : 'muted'}"></span>${h(status)}</div>
    <p class="channel-note">${enabled ? confirmed ? '手机测试已确认' : '尚未确认手机送达' : configured ? '绑定已保留' : chat ? '扫码绑定，需定期回复续期' : '绑定后接收服务号通知'}</p>
    <div class="channel-actions"><button class="text-button" data-action="${chat ? 'chat' : 'service'}">${configured ? '更换绑定' : '绑定并开启'}</button>${enabled ? `<button class="text-button" data-action="${chat ? 'test-chat' : 'test-service'}">发送测试</button>` : ''}${chat && enabled ? '<button class="text-button" data-action="chat-refresh">刷新会话</button>' : ''}${chat && configured && page === 'notifications' ? '<button class="text-button" data-action="chat-clear">清除绑定</button>' : ''}</div></section>`;
}
function recentRow(row) { return `<div class="recent-row"><div class="event-icon">${icon(row.stage === 'planned' ? 'bell' : 'check')}</div><div><h3>${h(row.title)}</h3><p>${time(row.at)} · 北京时间</p></div>${link(row.url)}</div>`; }
function home() {
  const s = data.status, c = data.chat, items = (s.activity || []).filter(row => !row.withdrawn), latest = items.find(row => row.stage !== 'banked');
  const fresh = s.lastSourceSuccess && Date.now() - s.lastSourceSuccess <= 900000 && !s.sourceError;
  const stageLabel = { planned: '重置预告', rolling: '正在发放', completed: 'Tibo 完成声明', observed: '第三方监测记录' }[latest?.stage];
  const title = fresh ? latest ? latest.title.replace(/^Tibo[：:]\s*|^监测站[：:]\s*/, '') : '暂未发现新的重置消息' : '暂时无法确认最新情况';
  const description = latest ? latest.stage === 'observed' ? '监测站记录到一次重置；你的账号是否到账，请查看额度页面。'
    : latest.stage === 'completed' ? 'Tibo 已宣布完成重置；你的账号是否到账，请查看额度页面。' : 'Tibo 发布了预告或发放进度，尚不能据此认定额度已到账。'
    : '有新的公开重置消息时，这里会自动更新。';
  return heading('最新消息', '', button('test', '测试通知', 'bell')) + warnings(s, c)
    + `<section class="hero"><div class="hero-head"><span class="pill ${!fresh || !latest || latest.stage === 'observed' ? 'neutral' : latest.stage === 'completed' ? '' : 'blue'}">${fresh ? stageLabel || '持续监测中' : '等待更新'}</span></div><h3>${h(title)}</h3><p class="description">${h(description)}</p><div class="hero-foot"><span>${latest ? '消息时间：' + time(latest.at) : '每两分钟自动检查'}${latest ? ' · 北京时间' : ''}</span>${latest ? link(latest.url) : ''}</div></section>`
    + `<h2 class="section-title">通知通道</h2><div class="channel-grid">${channelCard('service')}${channelCard('chat')}</div>`
    + `<h2 class="section-title">最近动态 <button class="text-button" data-nav="activity">查看全部 ${icon('chevron-right')}</button></h2><div class="card recent-card">${items.length ? items.slice(0, 3).map(recentRow).join('') : '<div class="empty">暂时没有重置消息。首次更新只建立记录，不补发历史通知。</div>'}</div>`;
}
function activity() {
  const s = data.status, c = data.chat;
  return heading('最近动态', `${(s.activity || []).length} 条记录`) + `<div class="activity-list">${(s.activity || []).map(row => {
    const chatResult = c?.recent?.find(r => r.key === row.key);
    const chatOutcome = chatResult ? outcomes[chatResult.status] || '状态未知' : ['historical', 'filtered', 'paused'].includes(row.service) ? outcomes[row.service] : c?.enabled === false ? '通道关闭 / 未开启' : '暂无发送记录';
    return `<article class="card activity-item"><header><div class="event-icon">${icon(row.withdrawn ? 'triangle-alert' : row.stage === 'planned' ? 'bell' : 'check')}</div><div><h3>${h(row.title)}</h3><time>${time(row.at)} · 北京时间</time></div>${link(row.url)}</header><p class="excerpt">${row.withdrawn ? '记录已更正：当前不再认定为重置消息。' : h(row.text || '请查看原帖或监测站记录。')}</p>${row.withdrawn ? '' : `<div class="outcomes"><span>服务号 · ${h(outcomes[row.service] || '未记录发送结果')}</span><span>聊天 · ${h(chatOutcome)}</span></div>`}</article>`;
  }).join('') || '<div class="card empty">尚无可展示的记录，首次成功更新后会显示最近动态。</div>'}</div><p class="subheading section-gap">“接口已接受”不代表手机实际收到。原帖中的 today / tomorrow 以作者当地语境为准。</p>`;
}
function notifications() {
  const s = data.status, settings = s.settings || {};
  return heading('通知通道', '', button('test', '测试通知', 'bell')) + warnings(s, data.chat)
    + `<div class="channel-grid">${channelCard('service')}${channelCard('chat')}</div><h2 class="section-title">提醒内容</h2><div class="card settings-card"><div class="setting-row"><div><h3>提醒范围</h3></div><div class="segmented" role="group" aria-label="提醒范围">${[['both', '预告 + 完成'], ['completed', '仅完成'], ['all', '全部进度']].map(([value, label]) => `<button class="${settings.alerts === value ? 'selected' : ''}" data-scope="${value}" aria-pressed="${settings.alerts === value}">${label}</button>`).join('')}</div></div><div class="setting-row"><div><h3>可储备重置</h3><p>额外提醒可手动使用的储备额度，默认关闭。</p></div>${switchControl('banked', settings.banked, '可储备重置提醒')}</div></div><h2 class="section-title section-gap">通知运行</h2><div class="card settings-card"><div class="setting-row"><div><h3>${s.paused ? '通知已暂停' : '允许发送通知'}</h3><p>暂停时继续更新动态，恢复后不补发暂停期间的消息。</p></div>${button(s.paused ? 'resume' : 'pause', s.paused ? '恢复通知' : '暂停通知', s.paused ? 'play' : 'pause')}</div></div>`;
}
function more() {
  const s = data.status;
  const row = (action, name, description, symbol) => `<button class="more-row" data-action="${action}">${icon(symbol)}<span><strong>${name}</strong><small>${description}</small></span><span class="arrow">${icon('chevron-right')}</span></button>`;
  return heading('工具管理') + `<div class="card settings-card">${data.setupPending ? row('continue', '继续上次开通', '使用已保存的进度接着设置', 'play') : ''}${row('updates', '检查更新', `本机 ${h(data.localVersion)} · 云端 ${h(s.version || '早期版本')}`, 'download')}${row('connect', '连接其他已有工具', '输入原网址和管理密钥，切换本机连接', 'link')}${row('recover', '恢复管理权限', '找不到原密钥时使用，恢复后旧密钥将失效', 'shield-check')}${row('diagnostics', '诊断信息', '查看数据读取、通道状态和错误代码', 'circle-help')}</div><p class="subheading section-gap">当前连接：${h(data.url)}</p>`;
}
function welcome() { return `<div class="welcome"><div class="brand-icon">${icon('activity')}</div><h2>开通重置提醒</h2><p>选择通知方式，完成云端开通。</p><div class="welcome-actions">${button('setup', '开始设置', 'plus', 'primary')}${button('connect', '连接已有工具', 'link')}</div><button class="text-button" data-action="recover">恢复管理权限</button></div>`; }
function offline() { return heading('无法连接云端', '本机连接配置已保留，可以刷新重试，也可以修复连接。') + `<div class="card"><p class="subheading">当前连接：${h(data.url)}</p><div class="welcome-actions">${data.setupPending ? button('continue', '继续开通', 'play', 'primary') : ''}${button('connect', '重新连接', 'link')}${button('recover', '恢复管理权限', 'shield-check')}</div><p class="subheading">网络异常时请检查系统代理；刚创建的云端网址可能需要几分钟生效。</p></div>`; }
function render() {
  const scrollTop = $('#main').scrollTop;
  document.querySelectorAll('[data-page]').forEach(el => { el.classList.toggle('active', el.dataset.page === page); el.setAttribute('aria-current', el.dataset.page === page ? 'page' : 'false'); });
  $('#page-name').textContent = titles[page];
  if (!connectionReady) { $('#main').innerHTML = `<div class="welcome"><h1>连接本机管理页面</h1><p>${h(latestError || '请重新双击“打开网页版.cmd”。')}</p></div>`; return; }
  const errorBox = latestError ? `<div class="notice">${icon('triangle-alert')}<span>当前状态读取失败：${h(latestError)}${data?.connected ? ' 下方为上次读取的记录。' : ''}</span></div>` : '';
  $('#main').innerHTML = '<div class="content">' + errorBox + (!data ? '<div class="loading"><span class="spinner"></span><p>正在读取最新动态…</p></div>' : !data.connected ? welcome() : !data.status ? offline() : ({ home, activity, notifications, more }[page])()) + '</div>';
  $('#main').scrollTop = scrollTop;
  const s = data?.status; const healthy = data?.connected && !latestError && s?.lastSourceSuccess && Date.now() - s.lastSourceSuccess <= 900000 && !s.sourceError;
  $('#cloud-state').innerHTML = `<span class="dot ${healthy ? s?.paused ? 'warning' : '' : 'muted'}"></span>${!data?.connected ? '尚未连接云端' : latestError ? '连接需要检查' : s?.paused ? '监控中 · 通知已暂停' : healthy ? '云端正在监控' : '等待数据更新'}`;
  $('#version').textContent = data?.localVersion ? `v${data.localVersion}` : '本机管理';
  $('#last-updated').textContent = s?.lastSourceSuccess ? `最近更新：${time(s.lastSourceSuccess)}（北京时间）` : '尚未读取到动态';
}
async function mutate(path, body, success) {
  if (pending) return; setBusy(true);
  try { await request('request', { path, body }); toast(success); await reload(); } catch (error) { toast(error.message); } finally { setBusy(false); }
}
async function run(action) {
  if (pending) return;
  try { await request('action', { action }); job = { state: 'running' }; activePrompt = ''; $('#prompt-area').innerHTML = ''; $('#qr-area').innerHTML = ''; $('#flow-guidance').innerHTML = ''; $('#flow-result').innerHTML = ''; $('#flow-logs').innerHTML = ''; $('#flow-title').textContent = '正在准备'; if (!$('#flow').open) $('#flow').showModal(); await pollJob(); }
  catch (error) { toast(error.message); }
}
function logsHtml(logs) { return logs.map(value => h(value).replace(/https:\/\/[^\s<，。；、“”）]+/g, url => { const decoded = url.replace(/&amp;/g, '&'); return external(decoded) ? `<a href="${external(decoded)}" target="_blank" rel="noreferrer">${url}</a>` : url; })).join('\n'); }
function showJob(value) {
  job = value; if (!job) return;
  const done = ['done', 'failed', 'cancelled'].includes(job.state);
  $('#flow-title').textContent = done ? job.state === 'done' ? '操作已结束' : '这一步尚未完成' : job.prompt ? '继续完成设置' : '正在为你处理';
  const seconds = Math.max(0, Math.floor((Date.now() - job.startedAt) / 1000));
  $('#flow-progress').innerHTML = done ? '' : `${job.state === 'waiting' ? icon('circle-help') : '<span class="spinner"></span>'}<span>${h(job.label)} · 已进行 ${seconds} 秒</span>`;
  $('#flow-close').disabled = !done && job.state !== 'waiting';
  const prompt = job.prompt;
  if (prompt && prompt.id !== activePrompt) {
    activePrompt = prompt.id;
    $('#prompt-area').innerHTML = `<h3 id="prompt-title">${h(prompt.title)}</h3>` + (prompt.type === 'choice' ? `<div class="choices">${Object.entries(prompt.options).sort(([a], [b]) => a === '0' ? 1 : b === '0' ? -1 : 0).map(([value, label]) => `<button class="choice ${value === prompt.fallback ? 'recommended' : ''}" data-reply="${h(value)}">${h(label)}${icon('chevron-right')}</button>`).join('')}</div>` : `<form id="answer-form"><div class="field"><input name="answer" type="${prompt.secret ? 'password' : 'text'}" aria-labelledby="prompt-title" autocomplete="off" spellcheck="false" maxlength="4096" required><button class="button primary" type="submit">继续</button></div>${prompt.secret ? '<p class="input-note">只用于当前操作，不会在页面或详情中显示。</p>' : ''}</form>`);
    $('#prompt-area input')?.focus();
  } else if (!prompt) { activePrompt = ''; $('#prompt-area').innerHTML = ''; }
  $('#flow-logs').innerHTML = logsHtml(job.logs || []);
  $('#flow-guidance').innerHTML = logsHtml(job.guidance || []);
  const qrKey = job.qr ? job.qr.expiresAt : '';
  if ($('#qr-area').dataset.qr !== String(qrKey)) {
    $('#qr-area').dataset.qr = String(qrKey);
    if (job.qr) {
      const modules = job.qr.modules, size = modules.length + 8;
      const path = modules.flatMap((row, y) => row.flatMap((dark, x) => dark ? [`M${x + 4},${y + 4}h1v1h-1z`] : [])).join('');
      $('#qr-area').innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="微信聊天绑定二维码" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="white"/><path d="${path}" fill="#172335"/></svg><p>使用接收提醒的手机微信扫一扫<br>二维码有效期约 5 分钟，请勿分享。</p>`;
    } else $('#qr-area').innerHTML = '';
  }
  $('#flow-result').innerHTML = done ? `<p>${h(job.error || (job.restart ? '本机文件已更新，请关闭本窗口及后台启动窗口，再重新打开网页版，之后可更新云端。' : '可返回页面查看当前状态。通知是否实际到达，以手机测试确认为准。'))}</p><button class="button primary" data-close-flow>返回页面</button>` : '';
}
async function pollJob() {
  if (polling) return; polling = true;
  try {
    const value = await request('job'); showJob(value);
    if (!value || !['running', 'waiting'].includes(value.state)) await reload();
  } catch (error) { job = { state: 'unavailable' }; $('#flow-result').textContent = error.message + ' 请保留后台窗口，刷新页面后可继续。'; $('#flow-close').disabled = false; }
  finally { polling = false; }
}
async function reply(value) {
  if (!job?.prompt) return;
  $('#prompt-area').querySelectorAll('button').forEach(b => { b.disabled = true; });
  try { await request('reply', { id: job.prompt.id, value }); } catch (error) { toast(error.message); activePrompt = ''; }
}
async function closeFlow() {
  if (job && ['running', 'waiting'].includes(job.state)) {
    if (job.state !== 'waiting') return;
    try { await request('cancel', {}); } catch (error) { toast(error.message); return; }
  }
  $('#flow').close(); await reload();
}
function diagnostics() {
  const s = data.status, c = data.chat;
  $('#flow-title').textContent = '诊断信息'; $('#flow-progress').innerHTML = ''; $('#flow-guidance').innerHTML = ''; $('#prompt-area').innerHTML = ''; $('#qr-area').innerHTML = ''; $('#flow-logs').innerHTML = ''; $('#flow-close').disabled = false;
  $('#flow-result').innerHTML = `<pre class="diagnostic">${h(JSON.stringify({ localVersion: data.localVersion, cloudVersion: s.version, sourceError: s.sourceError, lastCheck: time(s.lastCheck), serviceEnabled: s.service.enabled, serviceError: s.service.error, chatState: c?.state, chatError: c?.lastError, chatEnqueueError: s.clawbotEnqueueError }, null, 2))}</pre>`;
  job = null; $('#flow').showModal();
}
document.addEventListener('click', async event => {
  const el = event.target.closest('button'); if (!el || el.disabled) return;
  if (el.dataset.page || el.dataset.nav) { pageScroll.set(page, $('#main').scrollTop); page = el.dataset.page || el.dataset.nav; render(); $('#main').scrollTop = pageScroll.get(page) || 0; $('#main').focus({ preventScroll: true }); return; }
  if (el.dataset.reply !== undefined) return reply(el.dataset.reply);
  if (el.hasAttribute('data-close-flow')) return closeFlow();
  if (el.dataset.scope) return mutate('/settings', { ...data.status.settings, alerts: el.dataset.scope }, '提醒内容已保存');
  const toggle = el.dataset.toggle;
  if (toggle) {
    if (toggle === 'banked') return mutate('/settings', { ...data.status.settings, banked: !data.status.settings.banked }, '提醒内容已保存');
    const current = toggle === 'chat' ? data.chat : data.status.service;
    if (!current) return toast('暂时无法读取通道状态，请先刷新。');
    if (!current.configured) return run(toggle === 'chat' ? 'chat' : 'service');
    return mutate(toggle === 'chat' ? '/clawbot/toggle' : '/channels', toggle === 'chat' ? { enabled: !current.enabled } : { serviceEnabled: !current.enabled }, current.enabled ? '已关闭，绑定保留' : '已开启，不补发旧消息');
  }
  const action = el.dataset.action;
  if (!action) return;
  if (action === 'diagnostics') return diagnostics();
  if (action === 'chat-refresh') return mutate('/clawbot/refresh', {}, '已同步微信会话状态');
  if (action === 'chat-clear') { if (confirm('清除聊天绑定和待发消息？之后可以重新扫码。')) return mutate('/clawbot/disable', {}, '聊天绑定已清除'); return; }
  if (action === 'pause' || action === 'resume') return mutate('/' + action, {}, action === 'pause' ? '通知已暂停，动态继续更新' : '通知已恢复');
  return run(action);
});
document.addEventListener('submit', event => { if (event.target.id === 'answer-form') { event.preventDefault(); const value = new FormData(event.target).get('answer'); event.target.reset(); reply(value); } });
$('#refresh').addEventListener('click', () => reload(true));
$('#flow-close').addEventListener('click', closeFlow);
$('#flow').addEventListener('cancel', event => { event.preventDefault(); closeFlow(); });
$('#today').textContent = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'short' }).format(new Date());
async function init() {
  const token = location.hash.slice(1); history.replaceState(null, '', location.pathname);
  try {
    if (token) await request('session', { token });
    connectionReady = true; await reload();
    const current = await request('job');
    if (current && ['running', 'waiting'].includes(current.state)) { $('#flow').showModal(); await pollJob(); }
  } catch (error) { connectionReady = false; latestError = error.message; render(); }
}
await init();
setInterval(() => { if ($('#flow').open && job && ['running', 'waiting'].includes(job.state)) pollJob(); }, 1000);
setInterval(() => { if (document.visibilityState === 'visible' && !$('#flow').open && !pending && connectionReady) reload(); }, 60000);
