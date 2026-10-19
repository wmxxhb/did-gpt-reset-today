const DAY = 86400000;
const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const h = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = name => `<svg class="icon" aria-hidden="true"><use href="/icons.svg#${name}"/></svg>`;
export function chinaDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(dateFormat.formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
const validDay = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && chinaDate(value + 'T04:00:00Z') === value;

export function preserveOverview(previous, incoming) {
  if (!incoming.connected || incoming.status || !previous?.status || incoming.url !== previous.url) return incoming;
  return { ...incoming, status: { ...previous.status, sourceError: 'management_connection_failed' }, chat: previous.chat };
}

// Daily status describes messages on a Beijing calendar day. An explicitly
// future-dated preview must not be presented as a promise for its posting day.
function previewDay(row) {
  const text = String(row.text || '').replace(/https?:\/\/\S+/g, '').toLowerCase();
  const explicit = text.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
  if (explicit && validDay(explicit)) return explicit;
  if (/\b(tomorrow|next (?:day|week|month)|day after tomorrow)\b/.test(text)) return null;
  return chinaDate(row.at);
}

export function dashboardModel(status, now = Date.now()) {
  const today = chinaDate(now), byKey = new Map();
  const rows = [...(status.resetHistory || []), ...(status.activity || [])];
  for (const row of rows) {
    const at = Date.parse(row.at);
    if (row.withdrawn || !Number.isFinite(at) || at > now || !['completed', 'observed', 'planned', 'rolling'].includes(row.stage)) continue;
    const key = row.key || `${row.stage}:${row.at}`;
    const previous = byKey.get(key);
    if (previous?.stage === 'completed' && row.stage === 'observed') continue;
    byKey.set(key, row);
  }
  const withdrawn = new Set(status.withdrawnIds || []);
  const priority = { completed: 4, observed: 3, rolling: 2, planned: 1 };
  const records = [...byKey.values()].filter(row => !withdrawn.has(String(row.key || '').split(':')[0]))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || priority[b.stage] - priority[a.stage]);
  const days = {};
  for (const row of records) {
    const completed = ['completed', 'observed'].includes(row.stage);
    const day = completed ? chinaDate(row.at) : previewDay(row);
    if (!day) continue;
    const entry = days[day] ||= { completed: [], planned: [] };
    entry[completed ? 'completed' : 'planned'].push(row);
  }
  const completed = records.filter(row => ['completed', 'observed'].includes(row.stage));
  const fresh = !!status.lastSourceSuccess && now - status.lastSourceSuccess <= 900000 && !status.sourceError;
  const current = days[today];
  const state = current?.completed.length ? 'completed' : !fresh ? 'unknown' : current?.planned.length ? 'planned' : 'none';
  return { today, days, fresh, state, lastReset: completed[0] || null,
    todayRecord: current?.completed[0] || current?.planned[0] || null,
    firstDay: Object.keys(days).sort()[0] || null,
    title: { completed: '今日已重置', planned: '今日将会进行重置', none: '今日暂无重置消息', unknown: '今日状态暂无法确认' }[state] };
}

export function calendarMonth(month) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('无效月份');
  const [year, number] = month.split('-').map(Number);
  if (year < 1970 || year > 2200 || number < 1 || number > 12) throw new Error('无效月份');
  const start = Date.UTC(year, number - 1, 1);
  const offset = (new Date(start).getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(year, number, 0)).getUTCDate();
  const length = Math.ceil((offset + count) / 7) * 7;
  return Array.from({ length }, (_, index) => {
    const at = start + (index - offset) * DAY;
    const date = new Date(at).toISOString().slice(0, 10);
    return { date, day: Number(date.slice(-2)), inMonth: date.startsWith(month) };
  });
}
export function shiftMonth(month, delta) {
  calendarMonth(month);
  const [year, number] = month.split('-').map(Number);
  const result = new Date(Date.UTC(year, number - 1 + delta, 1)).toISOString().slice(0, 7);
  return result < '1970-01' ? '1970-01' : result > '2200-12' ? '2200-12' : result;
}
function sourceLink(row, label) {
  try {
    const u = new URL(row?.url);
    if (u.protocol !== 'https:' || !['x.com', 'twitter.com'].includes(u.hostname) || !/^\/thsottiaux\/status\/\d+\/?$/.test(u.pathname)) return '';
    return `<a href="${h(u.href)}" target="_blank" rel="noopener noreferrer">${label}${icon('arrow-up-right')}</a>`;
  } catch { return ''; }
}

export function renderOverview(status, { now = Date.now(), month, selectedDay } = {}) {
  const model = dashboardModel(status, now);
  if (!/^\d{4}-\d{2}$/.test(month || '')) month = model.today.slice(0, 7);
  if (!validDay(selectedDay) || !selectedDay.startsWith(month)) selectedDay = month === model.today.slice(0, 7) ? model.today : `${month}-01`;
  const [year, monthNumber] = month.split('-');
  const last = model.lastReset;
  const note = model.state === 'completed' ? '已有完成声明或监测记录，具体到账情况请查看账号额度。'
    : model.state === 'planned' ? '已有重置预告或发放进度，尚未确认完成。'
      : model.state === 'unknown' ? '数据未及时更新，请稍后刷新。'
        : '持续监测中，有新消息时自动更新。';
  const daysWithResets = Object.entries(model.days).filter(([day, entry]) => day.startsWith(month) && entry.completed.length).length;
  const selected = model.days[selectedDay];
  const selectedRow = selected?.completed[0] || selected?.planned[0];
  const selectedTitle = selected?.completed.length ? '已重置' : selected?.planned.length ? '收到重置预告' : '暂无重置记录';
  return `<div class="overview-summary"><section class="today-panel" aria-labelledby="today-title"><div class="overview-caption">今日状态<span>${model.today} · 北京时间</span></div><div class="today-title"><span class="status-symbol ${model.state}">${icon(model.state === 'completed' ? 'circle-check' : model.state === 'planned' ? 'bell' : model.state === 'unknown' ? 'triangle-alert' : 'activity')}</span><h2 id="today-title">${model.title}</h2></div><p>${note}</p>${model.todayRecord && model.state !== 'none' ? `<div class="today-source">${sourceLink(model.todayRecord, '查看原帖')}</div>` : ''}</section>
    <section class="last-reset" aria-labelledby="last-reset-title"><div><h2 id="last-reset-title">上次重置时间</h2><p>以完成声明或监测记录时间为准</p></div><div class="last-reset-value"><strong>${last ? timeFormat.format(new Date(last.at)) : '暂无完成记录'}</strong>${last ? sourceLink(last, last.stage === 'observed' ? '监测记录' : '完成声明') : ''}</div></section></div>
    <section class="reset-calendar" aria-labelledby="calendar-title"><div class="calendar-heading"><div><h2 id="calendar-title">重置日历</h2><p>按北京时间的消息日期归档</p></div><div class="calendar-controls"><button class="icon-button" data-calendar-step="-1" aria-label="上个月">${icon('arrow-left')}</button><span>${year} 年 ${Number(monthNumber)} 月</span><button class="icon-button" data-calendar-step="1" aria-label="下个月">${icon('chevron-right')}</button><button class="button" data-calendar-current>本月</button></div></div>
    <div class="calendar-weekdays" aria-hidden="true">${['一', '二', '三', '四', '五', '六', '日'].map(day => `<span>${day}</span>`).join('')}</div>
    <div class="calendar-grid" role="group" aria-label="${year}年${Number(monthNumber)}月重置记录">${calendarMonth(month).map(cell => {
      const entry = model.days[cell.date];
      const state = entry?.completed.length ? 'completed' : entry?.planned.length ? 'planned' : 'empty';
      const label = state === 'completed' ? '已重置' : state === 'planned' ? '预告' : '';
      return `<button class="calendar-day ${cell.inMonth ? '' : 'outside'} ${cell.date === model.today ? 'is-today' : ''} ${state}" data-calendar-day="${cell.date}" aria-pressed="${cell.date === selectedDay}" ${cell.date === model.today ? 'aria-current="date"' : ''} aria-label="${cell.date}${label ? '，' + label : '，暂无记录'}"><span class="calendar-day-number">${cell.day}${cell.date === model.today ? '<small>今天</small>' : ''}</span><span class="calendar-day-label">${state === 'completed' ? '重置' : label}</span></button>`;
    }).join('')}</div>
    <div class="calendar-summary"><div class="calendar-legend"><span><i class="completed"></i>已重置</span><span><i class="planned"></i>预告</span><span>无标记：暂无记录</span></div><span>本月 ${daysWithResets} 天有重置记录</span></div>
    <div class="calendar-selection" role="status"><span><strong>${selectedDay}</strong> ${selectedTitle}${selectedRow ? ' · ' + timeFormat.format(new Date(selectedRow.at)) : ''}</span>${sourceLink(selectedRow, '查看原帖')}</div></section>`;
}
