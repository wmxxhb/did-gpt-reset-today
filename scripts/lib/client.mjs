import { systemFetch } from './network.mjs';

// Stable deployment ID: preserve existing Cloudflare bindings when the product is renamed.
export const WORKER_NAME = 'tibo-wechat-reset-alert';

export function workerUrl(value, name = WORKER_NAME) {
  const text = String(value).trim();
  let u;
  try { u = new URL(text.startsWith('https://') ? text : `https://${text}`); }
  catch { throw new Error('请输入部署时的 workers.dev 地址。'); }
  if (u.protocol !== 'https:' || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev$/.test(u.hostname)
      || u.username || u.password || u.port || u.search || u.hash) throw new Error('请输入 Cloudflare 的 HTTPS workers.dev 地址。');
  if (u.hostname.split('.').length === 3) u.hostname = `${name}.${u.hostname}`;
  return u.origin;
}

export function deploymentUrl(text, name = WORKER_NAME) {
  const records = text.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } });
  const deploy = records.filter(r => r?.type === 'deploy').at(-1);
  const strings = [];
  const visit = value => {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(deploy?.targets);
  for (const value of strings) {
    if (!value.startsWith(`https://${name}.`) || !value.endsWith('.workers.dev')) continue;
    return workerUrl(value, name);
  }
  return null;
}

export async function api(profile, path, body, fetcher = systemFetch) {
  let response;
  try {
    response = await fetcher(workerUrl(profile.url) + path, {
      method: ['/status', '/settings', '/channels', '/clawbot/status'].includes(path) && body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${profile.admin}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000), redirect: 'error',
    });
  } catch (error) {
    const code = error.code || error.cause?.code;
    const messages = {
      ETIMEDOUT: '连接超时。请检查系统代理是否仍在运行，然后直接选择重试，无需重新输入密钥。',
      ENOTFOUND: '无法解析工具域名。请检查网络和 DNS；刚创建的网址可能需要几分钟生效。',
      PROXY_DNS_FAILED: '无法解析系统代理地址，请检查 Windows 代理设置。',
      CERTIFICATE_FAILED: '系统无法验证云端证书，请检查系统时间及代理证书配置。',
      TLS_FAILED: '无法建立安全连接，请检查系统网络及代理设置。',
      WINDOWS_NETWORK_UNAVAILABLE: '无法启动 Windows 网络组件，请重新打开工具后重试。',
    };
    const message = messages[code] || '连接云端失败。请检查 Windows 系统代理是否正常，然后直接重试，无需重新输入密钥。';
    throw Object.assign(new Error(message), { code: 'connection_failed' });
  }
  if (response.status === 407) throw Object.assign(new Error('系统代理要求身份验证，请先完成代理登录后重试。'), { code: 'connection_failed' });
  let data;
  try { data = await response.json(); } catch { throw new Error('工具返回了无法识别的响应，请从菜单更新程序后重试。'); }
  if (!response.ok) {
    const hints = {
      unauthorized: '管理凭据不匹配。请回到菜单，选择重新接管工具或导入原管理密钥。',
      test_rate_limited: '测试通知每分钟最多一条，请一分钟后重试。',
      invalid_settings: '提醒选项无效，请重新选择。',
      not_found: '云端版本尚不支持此功能，请从“更多 → 检查更新”更新云端程序。',
      invalid_channels: '通知开关无效，请重新选择。',
      service_not_configured: '服务号尚未绑定，请在“通知设置 → 服务号”中配置。',
      service_disabled: '服务号提醒已关闭，请先在通知设置中开启。',
      policy_sync_failed: '通知设置已保存，聊天通道同步暂时失败，请重试此操作；系统也会在下次检查时同步。',
      clawbot_reply_required: '聊天会话已过期或额度用尽。请向微信 ClawBot 回复一句话，再选择刷新会话状态。',
      clawbot_login_expired: 'ClawBot 登录已失效，请重新扫码绑定。',
      clawbot_disabled: '聊天提醒尚未开启，请先扫码绑定。',
      clawbot_timeout: '微信聊天接口暂时超时，请稍后重试。',
      clawbot_network_failed: '云端暂时无法连接微信聊天接口，请稍后重试。服务号监控仍独立运行。',
      clawbot_unavailable: '聊天通道暂时不可用，请稍后重试或更新云端程序。',
      clawbot_http_429: '微信聊天接口暂时限流，请稍后重试。',
      clawbot_needs_rebind: '微信提示已绑定其他实例，但本工具没有凭据，请在手机端重新建立绑定。',
      clawbot_invalid_host: '微信返回了未支持的服务器地址，已停止连接，请更新程序。',
      clawbot_invalid_response: '微信聊天接口返回了无法识别的结果，请稍后重试或更新程序。',
      clawbot_rejected: '微信暂未接受聊天请求，请先回复 ClawBot 一句话并刷新，仍失败时重新扫码绑定。',
    };
    throw Object.assign(new Error(hints[data.error] || data.hint || `操作失败（${data.reason || data.error || response.status}）。`), { code: data.error || 'request_failed' });
  }
  return data;
}

export function statusLines(s, now = Date.now()) {
  const age = s.lastSourceSuccess ? Math.max(0, Math.floor((now - s.lastSourceSuccess) / 60000)) : null;
  const health = s.paused ? '提醒已暂停' : s.sourceError ? '需要处理：暂时无法读取数据源'
    : !s.initialized ? '正在初始化，尚未开始监控' : age > 15 ? '需要检查：已超过 15 分钟没有更新数据' : '监控运行正常';
  const mode = { both: '预告和完成', completed: '仅提醒完成', all: '全部进度' }[s.settings?.alerts] || '全部进度';
  return [
    `运行状态：${health}`,
    `提醒内容：${mode}${s.settings?.banked ? '，包含可储备重置' : ''}`,
    `最近读取：${age === null ? '尚未成功读取' : `${age} 分钟前`}`,
    `服务号验证：${s.lastTestResult?.confirmedByUserAt ? '你已确认收到测试通知' : '尚未确认手机收到，请选择发送测试通知'}`,
    `等待重试：${s.pending?.length || 0} 条`,
  ];
}
