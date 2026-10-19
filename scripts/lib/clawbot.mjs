export function chatStatusLines(s) {
  const labels = { disabled: '未开启（可选）', needs_login: '需要重新扫码绑定', needs_reply: '请在微信中给 ClawBot 发一句话',
    quota_exhausted: '本轮额度已用尽，请回复 ClawBot 一句话', ready: '可以接收聊天提醒', error: '连接异常，请刷新或稍后重试' };
  return [
    `聊天提醒：${labels[s.state] || '状态未知，请更新程序'}`,
    ...(s.enabled ? [
      `会话到期：${s.expiresAt ? new Date(s.expiresAt).toLocaleString('zh-CN') : '等待你先发一句话'}`,
      `本轮剩余额度（估计）：${s.remainingEstimate} 条；待发送：${s.pending} 条`,
      `聊天测试：${s.lastTest?.confirmedByUserAt ? '你已确认收到' : '尚未确认手机收到'}`,
    ] : []),
  ];
}

export async function testClawbot(ui, api) {
  const status = await api('/clawbot/refresh', {});
  if (status.state === 'disabled') throw new Error('聊天提醒尚未开启。请进入“通知设置 → 聊天提醒”，扫码开启 ClawBot。');
  if (status.state === 'needs_login') throw new Error('ClawBot 登录已失效，请进入“通知设置 → 聊天提醒”，重新扫码绑定。');
  if (['needs_reply', 'quota_exhausted'].includes(status.state)) throw new Error('请先在微信中向 ClawBot 发一句话，然后重新发送聊天测试通知。');
  console.log('\n正在发送 ClawBot 聊天测试，请查看微信里的 ClawBot 会话。');
  await api('/clawbot/test', {});
  const answer = await ui.choose('请查看微信 ClawBot 会话，确认这次测试的提醒效果。', {
    1: '收到聊天测试通知，声音和未读提示符合预期', 2: '收到消息，但提醒效果不符合预期', 0: '没有收到 / 稍后检查',
  });
  if (answer === '1') { await api('/clawbot/confirm-test', {}); console.log('已记录聊天通道确认。之后按已开启的通道发送重置通知。'); }
  if (answer === '2') console.log('消息已到达，但系统通知权限、免打扰和微信版本会影响声音及角标。确认效果前可保持使用服务号。');
  if (answer === '0') console.log('接口接受不等于手机收到。请先向 ClawBot 回复一句话，再选择刷新和测试。');
  return answer === '1';
}

export async function manageClawbot(ui, api) {
  async function show() {
    const status = await api('/clawbot/status');
    console.log('\n' + chatStatusLines(status).join('\n'));
    return status;
  }
  while (true) {
    await show();
    const answer = await ui.choose('微信聊天提醒（ClawBot，可选）', {
      1: '扫码开启 / 更换聊天绑定', 2: '我已回复 ClawBot，刷新会话状态',
      3: '发送聊天测试通知', 4: '暂时关闭 / 重新开启聊天提醒', 5: '清除聊天绑定', 0: '返回通知设置',
    });
    if (answer === '0') return;
    if (answer === '2') { console.log(chatStatusLines(await api('/clawbot/refresh', {})).join('\n')); continue; }
    if (answer === '3') { await testClawbot(ui, api); continue; }
    if (answer === '4') {
      const status = await api('/clawbot/status');
      const choice = await ui.choose(status.enabled ? '关闭后保留绑定，停止聊天通知并清空待发消息。' : '重新开启后不会补发关闭期间的消息。', { 1: status.enabled ? '关闭聊天提醒' : '重新开启', 0: '返回' });
      if (choice === '1') await api('/clawbot/toggle', { enabled: !status.enabled });
      continue;
    }
    if (answer === '5') {
      const go = await ui.choose('将删除聊天通道的绑定和待发消息；之后可重新扫码开启。', { 1: '关闭聊天提醒', 0: '返回' });
      if (go === '1') { await api('/clawbot/disable', {}); console.log('聊天提醒已关闭，其他已开启的通知通道继续工作。'); }
      continue;
    }
    if (answer === '1') await bindClawbot(ui, api);
  }
}


export async function bindClawbot(ui, api, { testAfter = true } = {}) {
    console.log('\n开启后会额外发送微信 ClawBot 聊天通知，如果服务号也已开启，会同时发送两份提醒。');
    console.log('你需约每 24 小时回复一句话；连续约 10 条后也需回复。过期期间聊天消息最多等候 1 小时。');
    console.log('不需要备用微信号或常开电脑。请用实际接收通知的微信扫码；更换绑定会清空原聊天队列。');
    if (await ui.choose('是否开始扫码绑定？', { 1: '开始', 0: '返回' }, '1') === '0') return false;
    let qr;
    try { qr = (await import('qrcode-terminal')).default; }
    catch { throw new Error('缺少二维码组件，请重新双击“打开工具.cmd”，自动准备组件后再试。'); }
    const login = await api('/clawbot/login/start', {});
    console.log('\n用手机微信扫一扫下面的二维码，按手机提示确认。二维码 5 分钟内有效。');
    qr.generate(login.qrContent, { small: true });
    console.log('正在等待扫码确认；按 Ctrl+C 可退出，云端监控继续运行。');
    let result, verifyCode;
    while (Date.now() < login.expiresAt) {
      result = await api('/clawbot/login/poll', { id: login.id, ...(verifyCode ? { verifyCode } : {}) });
      if (['confirmed', 'expired', 'verify_code_blocked'].includes(result.status)) break;
      if (result.status === 'need_verifycode') {
        do { verifyCode = await ui.ask('输入手机微信显示的配对数字（输入隐藏）：', true); } while (!/^\d{4,12}$/.test(verifyCode));
      } else { verifyCode = undefined; await new Promise(resolve => setTimeout(resolve, 1000)); }
    }
    if (result?.status !== 'confirmed') { console.log('本次二维码已过期或验证未完成，请重新选择扫码。'); return false; }
    console.log('\n绑定成功。请在手机微信的 ClawBot 会话中发一句话，例如“开启提醒”。');
    if (await ui.choose('发送后继续：', { 1: testAfter ? '已发送，激活并测试' : '已发送，激活聊天提醒', 0: '稍后处理' }, '1') === '0') return true;
    const status = await api('/clawbot/refresh', {});
    if (status.state === 'ready' && testAfter) await testClawbot(ui, api);
    else console.log(chatStatusLines(status).join('\n'));
    return true;
}
