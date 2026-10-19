const log = (ui, ...args) => ui.log ? ui.log(...args) : console.log(...args);
import { chatStatusLines, testClawbot } from './clawbot.mjs';

export async function testService(ui, api) {
  log(ui, '\n正在发送服务号测试通知，请查看手机微信里的推送服务号。');
  await api('/test', {});
  const received = await ui.choose('服务号收到测试通知了吗？（这一步不测试 ClawBot）', {
    1: '服务号已收到', 2: '没收到，查看处理方法', 3: '稍后验证，先返回菜单',
  });
  if (received === '1') {
    await api('/confirm-test', {});
    log(ui, '服务号验证完成。电脑关机后，已部署的监控仍会在云端运行。');
  } else if (received === '2') {
    log(ui, '目前只确认推送服务收到了请求，尚未确认手机送达。');
    log(ui, '请检查公众号关注状态；需要重新绑定时，进入“通知设置 → 服务号”。');
    log(ui, '若刚注册免费网址，请等待几分钟。每个通道的测试通知每分钟最多一条。');
  } else log(ui, '配置已保留，服务号验证仍为“未确认收到”。');
  return received === '1';
}

export async function testNotificationChannels(ui, api) {
  let chat, service;
  try { const s = await api('/status'); service = s.service || { enabled: true }; }
  catch { log(ui, '暂时无法读取服务号状态，测试时会重新检查。'); }
  try { chat = await api('/clawbot/status'); }
  catch (error) {
    log(ui, error.code === 'not_found' ? '云端尚不支持聊天提醒，请从“更多 → 检查更新”更新程序。' : '暂时无法读取聊天状态；选择聊天测试时会重新检查。');
  }
  if (chat) log(ui, '\n' + chatStatusLines(chat).join('\n'));
  const options = { 0: '返回，不发送' };
  if (service?.enabled !== false) options[1] = '仅测试服务号';
  if (chat?.enabled !== false) options[2] = '仅测试 ClawBot 聊天提醒';
  if (options[1] && options[2]) options[3] = '分别测试服务号和 ClawBot';
  if (Object.keys(options).length === 1) { log(ui, '当前仅查看动态。请先在“通知设置”中开启一个通道。'); return []; }
  const answer = await ui.choose('选择已开启的通知通道进行测试（每个通道分别确认收到）', options,
    options[3] ? '3' : options[1] ? '1' : '2');
  const results = [];
  for (const [key, label, run] of [['1', '服务号', testService], ['2', 'ClawBot', testClawbot]]) {
    if (answer !== key && answer !== '3') continue;
    try {
      const confirmed = await run(ui, api);
      results.push({ channel: key, confirmed });
      log(ui, `${label}：${confirmed ? '你已确认收到' : '尚未确认收到'}。`);
    } catch (error) {
      log(ui, `${label}测试未完成：${error.message}`);
      results.push({ channel: key, confirmed: false, error: error.code || 'test_failed' });
    }
  }
  return results;
}
