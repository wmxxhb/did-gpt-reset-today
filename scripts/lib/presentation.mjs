import { chinaTime } from '../../src/classify.mjs';

const clean = value => String(value || '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/\x1b\[[0-9;]*m/g, '');
const chatLabels = { disabled: '关闭', needs_login: '需重新扫码', needs_reply: '需回复一句话续期',
  quota_exhausted: '需回复一句话续期', ready: '可用', error: '连接异常' };
const outcomes = { historical: '历史记录，不补发', filtered: '未通知：提醒范围未选中', paused: '未通知：已暂停',
  disabled: '未通知：通道关闭', queued: '等待发送', accepted: '接口已接受', failed: '发送失败，自动重试', expired: '已过期，不再补发', withdrawn: '记录已更正，不再发送' };

export function homeLines(s, chat, now = Date.now()) {
  const fresh = s.lastSourceSuccess && now - s.lastSourceSuccess <= 900000 && !s.sourceError;
  const latest = (s.activity || []).find(row => row.stage !== 'banked' && !row.withdrawn);
  const service = s.service || { enabled: true, configured: true };
  const lines = ['\nGPT今天重置了吗？', '关注 Codex / ChatGPT Work 的公开重置消息。'];
  if (!fresh) lines.push('最新动态：暂时无法确认最新情况' + (s.initialized ? '，正在自动更新' : '，等待首次更新'));
  else if (latest) lines.push('最新动态：' + clean(latest.title));
  else lines.push('最新动态：暂未发现新的重置消息');
  if (latest) {
    lines.push(`消息时间：${chinaTime(latest.at)}`);
    if (latest.url) lines.push(`原帖：${latest.url}`);
  }
  lines.push('最近更新：' + (s.lastSourceSuccess ? chinaTime(s.lastSourceSuccess) : '尚未成功读取'));
  const mode = { both: '预告 + 完成', completed: '仅完成', all: '全部进度' }[s.settings?.alerts];
  if (mode) lines.push('提醒内容：' + mode + (s.settings?.banked ? '，包含可储备重置' : ''));
  lines.push(`服务号：${!service.enabled ? '关闭' : !service.configured ? '未绑定' : service.error ? '需要检查' : '可用'}${service.enabled && service.configured ? service.lastTest?.confirmedByUserAt ? ' · 你已确认测试收到' : ' · 尚未确认手机收到' : ''}`);
  lines.push(`聊天提醒：${chat ? chatLabels[chat.state] || '状态未知' : '暂时无法读取状态'}${chat?.state === 'ready' ? chat.lastTest?.confirmedByUserAt ? ' · 你已确认测试收到' : ' · 尚未确认手机收到' : ''}`);
  if (s.paused) lines.push('通知已暂停，仍会更新动态；恢复后不补发暂停期间的消息。');
  else if (!service.enabled && chat?.enabled === false) lines.push('仅查看动态，通知未开启。');
  else {
    const usable = (service.enabled && service.configured && !service.error) || chat?.state === 'ready';
    if (!usable) lines.push('需要处理：当前没有已确认可用的通知通道，请进入“通知设置”。');
    if (chat?.enabled && ['needs_reply', 'quota_exhausted'].includes(chat.state)) {
      lines.push('下一步：在微信给 ClawBot 回复任意内容，约两分钟内自动恢复。');
      if (service.enabled && service.configured && !service.error) lines.push('服务号仍可接收通知。');
    } else if (chat?.enabled && chat.state === 'needs_login') lines.push('下一步：通知设置 → 聊天提醒 → 重新扫码。');
  }
  if (s.clawbotEnqueueError) lines.push('聊天消息转交异常，系统会重试；可从“更多 → 诊断信息”查看。');
  return lines;
}

export function activityLines(s, chat, limit = 12) {
  const rows = (s.activity || []).slice(0, limit);
  if (!rows.length) return ['尚无可展示的记录，首次更新后会显示最近动态。'];
  const lines = ['\n最近动态（时间均为北京时间）'];
  for (const row of rows) {
    lines.push(`\n${chinaTime(row.at)}  ${clean(row.title)}`);
    if (row.withdrawn) { lines.push('记录已更正：当前不再认定为重置消息。'); continue; }
    if (row.text) lines.push(clean(row.text).replace(/\s+/g, ' ').slice(0, 220));
    if (row.url) lines.push(row.url);
    lines.push('服务号：' + (outcomes[row.service] || '未记录发送结果'));
    const result = chat?.recent?.find(item => item.key === row.key);
    let note = result ? outcomes[result.status] || '未记录发送结果' : row.service === 'historical' ? '历史记录，不补发'
      : row.service === 'filtered' ? outcomes.filtered : row.service === 'paused' ? outcomes.paused
        : chat?.enabled === false ? '通道关闭 / 此事件未开启聊天提醒' : '暂无聊天发送记录';
    if (result?.status === 'queued' && ['needs_reply', 'quota_exhausted'].includes(chat.state)) note = '等待你回复 ClawBot，过期后不补发';
    lines.push('聊天提醒：' + note);
  }
  lines.push('\n“接口已接受”不代表手机实际送达。Data: https://codex-reset.com/');
  return lines;
}
