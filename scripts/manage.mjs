import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { UI } from './lib/ui.mjs';
import { api as requestApi, workerUrl, deploymentUrl } from './lib/client.mjs';
import { saveProfile, loadProfile } from './lib/profile.mjs';
import { deploy, wrangler } from './lib/cloud.mjs';
import { manageClawbot, bindClawbot } from './lib/clawbot.mjs';
import { testService, testNotificationChannels } from './lib/notification-tests.mjs';
import { homeLines, activityLines } from './lib/presentation.mjs';
import { latestVersion, newer, updateLocal, REPOSITORY } from './lib/updates.mjs';
import { VERSION } from '../src/version.mjs';
import { RECOMMENDED_SETTINGS } from '../src/settings.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ui = new UI();
let profile;

const REQUEST_LABELS = {
  '/status': '正在连接云端并检查状态', '/settings': '正在读取或保存提醒选项',
  '/test': '正在提交服务号测试通知', '/confirm-test': '正在保存你的送达确认',
  '/check': '正在检查最新公告', '/pause': '正在暂停提醒', '/resume': '正在恢复提醒',
  '/reset-test': '正在更新微信验证状态', '/channels': '正在保存通知开关',
  '/clawbot/toggle': '正在切换聊天提醒',
  '/clawbot/login/start': '正在生成微信聊天绑定二维码', '/clawbot/login/poll': '正在等待手机扫码确认',
  '/clawbot/status': '正在读取聊天通道状态', '/clawbot/refresh': '正在同步你发给 ClawBot 的消息',
  '/clawbot/test': '正在提交聊天测试通知', '/clawbot/confirm-test': '正在记录聊天送达确认',
  '/clawbot/disable': '正在关闭并清除聊天绑定',
};
function api(account, path, body) {
  return ui.task(REQUEST_LABELS[path] || '正在连接云端', () => requestApi(account, path, body), { timeoutMs: 30000 });
}

function remember(account) {
  return ui.task('正在加密保存本机管理凭据', () => saveProfile(root, account));
}

async function askUrl(detected) {
  if (detected) return detected;
  console.log('请复制部署输出的网址；只复制账号子域名也可以，向导会补全。');
  while (true) {
    try { return workerUrl(await ui.ask('网址：')); }
    catch (e) { console.log(e.message); }
  }
}

async function selectPush() {
  const answer = await ui.choose('选择服务号提供商', {
    1: '虾推啥：免费微信通道，关注公众号即可取 token（推荐）',
    2: 'pushplus：适合已有账号，服务商可能收实名费用', 0: '返回',
  }, '1');
  if (answer === '0') return null;
  const provider = answer === '1' ? 'xtuis' : 'pushplus';
  console.log(provider === 'xtuis'
    ? '\n打开 https://xtuis.cn/，微信扫码关注公众号，复制 token。不要选择付费升级版。'
    : '\n打开 https://www.pushplus.plus/，复制消息 token。');
  console.log('下面输入不显示内容。只在本机填写，不需要发送给任何人。');
  while (true) {
    let token = await ui.ask('粘贴公众号提供的 token（输入 0 返回）：', true);
    if (token === '0') return null;
    if (provider === 'xtuis' && token.startsWith('https://')) {
      try {
        const u = new URL(token);
        if (u.hostname !== 'wx.xtuis.cn' || !/^\/[^/]+\.send$/.test(u.pathname)) throw new Error();
        token = decodeURIComponent(u.pathname.slice(1, -5));
      } catch { console.log('这个链接无法识别，请复制公众号中的 token 本身。'); continue; }
    }
    if (!token || /\s|[/:?#]/.test(token)) { console.log('token 格式不正确，请重新复制，不要附带说明文字。'); continue; }
    return { provider, token };
  }
}

async function chooseSettings() {
  const alerts = await ui.choose('哪些消息需要提醒？', {
    1: '预告 + 完成：决定重置时提醒，完成时再提醒（推荐）',
    2: '仅提醒完成：只关注完成声明和监测站完成记录',
    3: '全部进度：预告、正在发放、完成都提醒', 0: '返回，不修改',
  }, '1');
  if (alerts === '0') return null;
  const banked = await ui.choose('是否额外提醒“可储备重置”？这类重置通常需要手动使用。', {
    1: '不提醒（推荐）', 2: '提醒', 0: '返回，不修改',
  }, '1');
  return banked === '0' ? null : { alerts: { 1: 'both', 2: 'completed', 3: 'all' }[alerts], banked: banked === '2' };
}

const accountApi = (path, body) => api(profile, path, body);

async function readOverview() {
  const [primary, chat] = await ui.task('正在读取最新动态和通知状态', () => Promise.allSettled([
    requestApi(profile, '/status'), requestApi(profile, '/clawbot/status'),
  ]));
  if (primary.status !== 'fulfilled') throw primary.reason;
  return { status: primary.value, chat: chat.status === 'fulfilled' ? chat.value : null };
}

async function showStatus() {
  const { status, chat } = await readOverview();
  console.log(homeLines(status, chat).join('\n'));
  if (!status.version || newer(VERSION, status.version)) console.log('有可用的云端更新，请进入“更多 → 检查更新”。');
  if (profile.setup) console.log('首次设置尚未完成，可从“更多 → 继续开通”接着处理。');
  return status;
}

async function bindService(test = true) {
  const push = await selectPush();
  if (!push) return false;
  await wrangler(root, ['secret', 'bulk'], { ui, input: JSON.stringify({
    PUSH_PROVIDER: push.provider, [push.provider === 'xtuis' ? 'XTUIS_TOKEN' : 'PUSHPLUS_TOKEN']: push.token,
  }) });
  profile.provider = push.provider; await remember(profile);
  await accountApi('/channels', { serviceEnabled: true });
  await accountApi('/reset-test', {});
  if (test) await testService(ui, accountApi);
  return true;
}

async function notificationSettings() {
  while (true) {
    const { status, chat } = await readOverview();
    const service = status.service || { enabled: true, configured: true };
    const answer = await ui.choose('通知设置：两个通道独立开关，均开启时同时发送。', {
      1: `服务号：${service.enabled ? '开启' : '关闭'}${service.configured ? '' : '（未绑定）'}`,
      2: `聊天提醒：${chat?.enabled ? '开启' : '关闭'}${chat?.state === 'needs_reply' || chat?.state === 'quota_exhausted' ? '（请回复一句话续期）' : ''}`,
      0: '返回首页',
    });
    if (answer === '0') return;
    if (answer === '2') { await manageClawbot(ui, accountApi); continue; }
    const choice = await ui.choose('服务号提醒', {
      1: service.enabled ? '关闭服务号提醒（保留绑定）' : service.configured ? '开启服务号提醒' : '绑定并开启服务号提醒',
      2: '更换绑定', ...(service.enabled ? { 3: '发送服务号测试通知' } : {}), 0: '返回通知设置',
    });
    if (choice === '1') {
      if (!service.enabled && !service.configured) await bindService();
      else await accountApi('/channels', { serviceEnabled: !service.enabled });
    }
    if (choice === '2') await bindService();
    if (choice === '3') await testService(ui, accountApi);
  }
}

async function importService() {
  let detected;
  try { detected = deploymentUrl(await readFile(resolve(root, '.tibo-local/deploy.ndjson'), 'utf8')); } catch { /* New machine: ask once. */ }
  const url = await askUrl(detected);
  console.log('连接工具：' + url);
  let admin = await ui.ask('粘贴原管理密钥（输入隐藏，只需这一次）：', true);
  if (admin.length < 32) throw new Error('管理密钥不完整，请重新复制。');
  const candidate = { url, admin, provider: 'existing', createdAt: Date.now() };
  while (true) {
    try { await api(candidate, '/status'); break; }
    catch (error) {
      console.log('\n' + error.message);
      const choice = await ui.choose('选择下一步，当前输入会保留在本次操作中：', {
        1: '直接重试，不重新输入密钥', 2: '重新填写管理密钥', 0: '返回，取消本次连接',
      }, error.code === 'unauthorized' ? '2' : '1');
      if (choice === '0') return;
      if (choice === '2') {
        do {
          admin = await ui.ask('粘贴原管理密钥（输入隐藏）：', true);
          if (admin.length < 32) console.log('管理密钥不完整，请重新填写。');
        } while (admin.length < 32);
        candidate.admin = admin;
      }
    }
  }
  await remember(candidate);
  profile = candidate;
  console.log('已连接现有工具，并加密保存本机管理凭据。');
}

async function continueSetup() {
  const setup = profile.setup;
  if (!setup) return;
  if (setup.secrets) {
    await wrangler(root, ['secret', 'bulk'], { ui, input: JSON.stringify(setup.secrets) });
    delete setup.secrets; setup.phase = 'settings'; await remember(profile);
  }
  // Credentials are saved before network calls, so failures can resume this step.
  for (let attempt = 0; ; attempt++) {
    try { await accountApi('/status'); break; }
    catch (error) {
      if (attempt >= 3) throw error;
      await ui.task('等待云端生效，5 秒后重试', () => new Promise(done => setTimeout(done, 5000)));
    }
  }
  if (setup.takeover) { delete profile.setup; await remember(profile); return; }
  if (setup.phase === 'settings') {
    await accountApi('/channels', { serviceEnabled: setup.service });
    await accountApi('/settings', RECOMMENDED_SETTINGS);
    await accountApi('/check', {});
    setup.phase = 'binding'; await remember(profile);
  }
  if (setup.phase === 'binding') {
    if (setup.chat) {
      const chat = await accountApi('/clawbot/status');
      if (!chat.configured && !(await bindClawbot(ui, accountApi, { testAfter: false }))) return;
      if (chat.configured && !chat.enabled) await accountApi('/clawbot/toggle', { enabled: true });
    }
    setup.phase = 'test'; await remember(profile);
  }
  if (setup.service || setup.chat) await testNotificationChannels(ui, accountApi);
  delete profile.setup; await remember(profile);
  console.log('开通流程已完成。是否实际收到，以各通道的手机测试确认为准。电脑关机后仍会在云端运行。');
}

async function openService(takeover = false) {
  if (takeover) {
    const choice = await ui.choose('恢复管理权限会更新云端并使原管理密钥失效，已有绑定和记录保留。', {
      1: '继续恢复管理权限', 2: '改用原网址和密钥连接', 0: '返回',
    });
    if (choice === '0') return;
    if (choice === '2') return importService();
  }
  let mode, push;
  if (!takeover) {
    mode = await ui.choose('希望如何接收重置提醒？', {
      1: '服务号：维护操作少，提醒可能被微信折叠',
      2: '聊天提醒：扫码绑定 ClawBot，需要定期回复续期',
      3: '两种都开启：同时收到两份通知', 4: '先只看动态，不开启通知', 0: '返回',
    });
    if (mode === '0') return;
    if (['1', '3'].includes(mode)) { push = await selectPush(); if (!push) return; }
  }
  if (await ui.choose('云端每两分钟检查。默认提醒预告和完成，可稍后修改。', {
    1: '开始，按浏览器提示登录 Cloudflare', 0: '返回',
  }, '1') === '0') return;
  await wrangler(root, ['login'], { ui });
  const url = await askUrl(await deploy(root, ui));
  const admin = randomBytes(32).toString('hex');
  const secrets = { ADMIN_TOKEN: admin };
  if (!takeover) secrets.SOURCE_USER_AGENT = `DidGPTResetToday/${VERSION} (+${REPOSITORY})`;
  if (push) {
    secrets.PUSH_PROVIDER = push.provider;
    secrets[push.provider === 'xtuis' ? 'XTUIS_TOKEN' : 'PUSHPLUS_TOKEN'] = push.token;
  }
  profile = { url, admin, provider: push?.provider || 'existing', createdAt: Date.now(),
    setup: { takeover, service: ['1', '3'].includes(mode), chat: ['2', '3'].includes(mode), secrets, phase: 'secrets' } };
  await remember(profile);
  await continueSetup();
}

async function checkUpdates() {
  const status = await accountApi('/status');
  console.log(`本机版本：${VERSION}；云端版本：${status.version || '早期版本'}`);
  let latest;
  try {
    latest = await ui.task('正在检查 GitHub 更新', () => latestVersion());
    console.log(`公开版本：${latest.version}`);
  } catch (error) { console.log(error.message); }
  const localUpdate = latest && newer(latest.version, VERSION);
  const choice = await ui.choose('更新会保留通知绑定和提醒设置。', {
    ...(localUpdate ? { 1: '更新本机工具，完成后重新打开' } : {}),
    2: '更新云端程序（使用当前本机版本）', 0: '返回',
  }, localUpdate ? '1' : '0');
  if (choice === '1') {
    await ui.task('正在更新本机文件，保留原有配置', () => updateLocal(root, latest.sha), { inline: false });
    console.log('本机已更新。请关闭并重新双击“打开工具.cmd”，再进入“更多 → 检查更新”更新云端。');
    return 'restart';
  }
  if (choice === '2') {
    if (status.version && newer(status.version, VERSION)) throw new Error('云端版本更新，请先更新本机工具，避免覆盖成旧版本。');
    const url = await deploy(root, ui);
    if (url && url !== profile.url) throw new Error('部署账号与原工具不同，请登录原 Cloudflare 账号后重试。');
    console.log('云端已更新，绑定和设置已保留。');
  }
}

async function moreSettings() {
  while (true) {
    const answer = await ui.choose('更多', {
      1: '提醒内容（预告、完成与可储备重置）', 2: '检查更新',
      3: '连接其他已有工具', 4: '恢复管理权限（原管理密钥将失效）',
      5: '诊断信息', ...(profile.setup ? { 6: '继续开通' } : {}), 0: '返回首页',
    });
    if (answer === '0') return;
    if (answer === '1') { const settings = await chooseSettings(); if (settings) await accountApi('/settings', settings); }
    if (answer === '2' && await checkUpdates() === 'restart') return 'restart';
    if (answer === '3') { await importService(); return; }
    if (answer === '4') { await openService(true); return; }
    if (answer === '5') {
      const { status, chat } = await readOverview();
      console.log(JSON.stringify({ localVersion: VERSION, cloudVersion: status.version,
        sourceError: status.sourceError, lastCheck: status.lastCheck, service: status.service,
        chat: chat && { state: chat.state, lastError: chat.lastError, pending: chat.pending },
        chatEnqueueError: status.clawbotEnqueueError }, null, 2));
    }
    if (answer === '6') await continueSetup();
  }
}

async function main() {
  console.log('GPT今天重置了吗？ · 打开看动态，开启通知后可关闭电脑。');
  try { profile = await ui.task('正在读取本机配置', () => loadProfile(root)); } catch (error) { console.log(error.message); }
  if (profile?.setup && await ui.choose('上次开通尚未完成，已保存进度。', { 1: '接着完成', 0: '稍后处理' }, '1') === '1') {
    try { await continueSetup(); } catch (error) { console.log(error.message); }
  }
  while (true) {
    try {
      if (!profile) {
        const choice = await ui.choose('欢迎使用', { 1: '第一次使用，开始设置', 2: '连接已有工具', 3: '恢复管理权限', 0: '退出' });
        if (choice === '0') return;
        if (choice === '1') await openService();
        if (choice === '2') await importService();
        if (choice === '3') await openService(true);
        continue;
      }
      let status;
      try { status = await showStatus(); }
      catch (error) { console.log('首页暂时无法更新：' + error.message); }
      const answer = await ui.choose('选择操作', {
        1: '查看最近动态', 2: '通知设置', 3: '发送测试通知',
        4: status?.paused ? '恢复通知' : '暂停通知', 5: '更多', 0: '退出，云端继续运行',
      });
      if (answer === '0') return;
      if (answer === '1') {
        const result = await readOverview(); console.log(activityLines(result.status, result.chat).join('\n'));
      }
      if (answer === '2') await notificationSettings();
      if (answer === '3') await testNotificationChannels(ui, accountApi);
      if (answer === '4') {
        const current = await accountApi('/status');
        if (await ui.choose(current.paused ? '恢复后只通知新的动态。' : '暂停后仍更新动态，但不发送通知；暂停期间的消息不会补发。', {
          1: current.paused ? '恢复通知' : '暂停通知', 0: '返回',
        }, '1') === '1') await accountApi(current.paused ? '/resume' : '/pause', {});
      }
      if (answer === '5' && await moreSettings() === 'restart') return;
    } catch (error) {
      console.log('这一步尚未完成：' + error.message);
      console.log('已有配置已保留，可以重试；首次设置中断时可从“更多 → 继续开通”恢复。');
    }
  }
}

try { await main(); } finally { ui.close(); }
