import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { UI } from './lib/ui.mjs';
import { api as requestApi, statusLines, workerUrl, deploymentUrl } from './lib/client.mjs';
import { saveProfile, loadProfile } from './lib/profile.mjs';
import { deploy, wrangler } from './lib/cloud.mjs';
import { manageClawbot, chatStatusLines } from './lib/clawbot.mjs';
import { testService, testNotificationChannels } from './lib/notification-tests.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ui = new UI();
let profile;

const REQUEST_LABELS = {
  '/status': '正在连接云端并检查状态', '/settings': '正在读取或保存提醒选项',
  '/test': '正在提交服务号测试通知', '/confirm-test': '正在保存你的送达确认',
  '/check': '正在检查最新公告', '/pause': '正在暂停提醒', '/resume': '正在恢复提醒',
  '/reset-test': '正在更新微信验证状态',
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
  const answer = await ui.choose('微信通知用哪个通道？', {
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

async function testPhone() {
  return testService(ui, (path, body) => api(profile, path, body));
}

async function showStatus() {
  const status = await api(profile, '/status');
  console.log('\n' + statusLines(status).join('\n'));
  console.log('工具地址：' + profile.url);
  try { console.log(chatStatusLines(await api(profile, '/clawbot/status')).join('\n')); }
  catch (error) {
    console.log(error.code === 'not_found' ? '聊天提醒：云端版本尚不支持，可从菜单更新后开启。' : '聊天通道状态暂时无法读取。');
  }
  return status;
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

async function openService(takeover = false) {
  if (takeover) {
    const confirm = await ui.choose('接管会更新云端程序，并生成本机管理凭据。原管理密钥将失效；微信绑定和监控记录会保留。', {
      1: '继续自动接管（无需找回原密钥）', 2: '改用原密钥导入，保留旧管理权限', 0: '返回',
    }, '1');
    if (confirm === '0') return;
    if (confirm === '2') return importService();
  }
  const push = takeover ? null : await selectPush();
  if (!takeover && !push) return;
  let contact;
  if (!takeover) {
    console.log('\n数据站要求请求中附一个联系方式，仅用于标识数据接口使用者。');
    while (true) {
      contact = await ui.ask('填写你的联系邮箱或项目 HTTPS 地址：');
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact) || /^https:\/\/[^\s]+$/.test(contact)) break;
      console.log('请填写有效邮箱或 HTTPS 地址。');
    }
  }
  const settings = takeover ? null : await chooseSettings();
  if (!takeover && !settings) return;
  const go = await ui.choose(`准备${takeover ? '接管' : '开通'}：每两分钟云端检查，不需要购买域名或服务器。`, {
    1: '开始；浏览器打开后按提示登录并授权 Cloudflare', 0: '返回，不进行云端操作',
  }, '1');
  if (go === '0') return;
  await wrangler(root, ['login'], { ui });
  const url = await askUrl(await deploy(root, ui));
  const admin = randomBytes(32).toString('hex');
  const secrets = { ADMIN_TOKEN: admin };
  if (push) {
    secrets.PUSH_PROVIDER = push.provider;
    secrets[push.provider === 'xtuis' ? 'XTUIS_TOKEN' : 'PUSHPLUS_TOKEN'] = push.token;
    secrets.SOURCE_USER_AGENT = `DidGPTResetToday/0.1 (+${contact.includes('@') ? 'mailto:' : ''}${contact})`;
  }
  console.log('\n正在保存云端绑定和本机管理凭据，不需要手动复制密钥……');
  await wrangler(root, ['secret', 'bulk'], { ui, input: JSON.stringify(secrets) });
  profile = { url, admin, provider: push?.provider || 'existing', contact, createdAt: Date.now() };
  await remember(profile);
  console.log('已用当前 Windows 账号加密保存管理凭据。');
  for (let attempt = 0; attempt < 6; attempt++) {
    try { await api(profile, '/status'); break; }
    catch (error) {
      if (attempt === 5) throw error;
      console.log('正在等待云端配置生效……本机凭据已保存，之后可直接从菜单重试。');
      await ui.task('等待云端配置生效，5 秒后自动重试', () => new Promise(resolveWait => setTimeout(resolveWait, 5000)));
    }
  }
  if (settings) await api(profile, '/settings', settings);
  await api(profile, '/check', {});
  await showStatus();
  await testPhone();
}

async function main() {
  console.log('\nGPT今天重置了吗？ · 中文管理向导');
  console.log('输入编号即可操作，不需要拼网址或测试命令。');
  try { profile = await ui.task('正在读取本机配置', () => loadProfile(root)); } catch (error) { console.log(error.message); }
  while (true) {
    try {
      if (!profile) {
        const answer = await ui.choose('欢迎使用。你现在属于哪种情况？', {
          1: '第一次使用：开通微信提醒',
          2: '已经开通：更新并自动接管（旧管理密钥将失效）',
          3: '已经开通：输入原网址和管理密钥连接', 0: '退出',
        });
        if (answer === '0') return;
        if (answer === '1') await openService();
        if (answer === '2') await openService(true);
        if (answer === '3') await importService();
        continue;
      }
      const answer = await ui.choose('选择你要做的事', {
        1: '查看运行状态', 2: '发送测试通知（选择通道）', 3: '选择提醒内容',
        4: '暂停 / 恢复提醒', 5: '更换服务号微信绑定', 6: '更新云端程序（保留绑定）',
        7: '重新接管管理权限（旧管理密钥将失效）', 0: '退出，云端监控继续运行',
        8: '微信聊天提醒（ClawBot，可选）',
      }, '1');
      if (answer === '0') return;
      if (answer === '1') await showStatus();
      if (answer === '2') await testNotificationChannels(ui, (path, body) => api(profile, path, body));
      if (answer === '3') {
        const settings = await chooseSettings();
        if (settings) { await api(profile, '/settings', settings); console.log('提醒选项已生效。'); }
      }
      if (answer === '4') {
        const status = await api(profile, '/status');
        const choice = await ui.choose(status.paused ? '提醒当前已暂停。' : '提醒当前正在运行。', {
          1: status.paused ? '恢复提醒' : '暂停提醒', 0: '返回，不修改',
        }, '1');
        if (choice === '1') { await api(profile, status.paused ? '/resume' : '/pause', {}); console.log(status.paused ? '提醒已恢复。' : '提醒已暂停。'); }
      }
      if (answer === '5') {
        const push = await selectPush();
        if (push) {
          await wrangler(root, ['secret', 'bulk'], { ui, input: JSON.stringify({
            PUSH_PROVIDER: push.provider, [push.provider === 'xtuis' ? 'XTUIS_TOKEN' : 'PUSHPLUS_TOKEN']: push.token,
          }) });
          profile.provider = push.provider; await remember(profile);
          await api(profile, '/reset-test', {}); await testPhone();
        }
      }
      if (answer === '6') {
        const url = await deploy(root, ui);
        if (url && url !== profile.url) throw new Error('此次部署地址与原工具不同。可能登录了另一个 Cloudflare 账号；本机仍保留原工具配置，请登录原账号后重试。');
        await showStatus();
      }
      if (answer === '7') await openService(true);
      if (answer === '8') await manageClawbot(ui, (path, body) => api(profile, path, body));
    } catch (error) {
      console.log('\n这一步尚未完成：' + error.message);
      console.log('可从菜单选择重试；不需要重新注册微信推送账号。');
    }
  }
}

try { await main(); } finally { ui.close(); }
