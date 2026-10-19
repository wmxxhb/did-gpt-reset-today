import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
export class WebUI {
  constructor() {
    this.browser = true; this.state = 'running'; this.logs = []; this.label = '正在准备';
    this.startedAt = Date.now(); this.prompt = null; this.qr = null; this.privateValues = []; this.guidance = [];
  }
  clean = value => {
    let text = String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
    for (const secret of this.privateValues) if (secret) text = text.split(secret).join('[已隐藏]');
    return text.replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]').slice(0, 4000);
  };
  log = (...args) => { this.logRaw(...args); this.guidance.push(...args.map(this.clean).filter(Boolean)); this.guidance = this.guidance.slice(-4); };
  logRaw = (...args) => { for (const text of args.map(this.clean).filter(Boolean)) this.logs.push(text); this.logs = this.logs.slice(-60); };
  async task(label, callback) {
    const previous = this.label; this.label = label;
    try { return await callback(); } finally { this.label = previous; }
  }
  ask(title, secret = false) { return this.wait({ type: 'text', title, secret }); }
  choose(title, options, fallback) { return this.wait({ type: 'choice', title, options, fallback }); }
  wait(prompt) {
    if (this.state === 'cancelled') return Promise.reject(new Error('已退出本次操作，已保存的配置仍保留。'));
    return new Promise((resolveAnswer, reject) => {
      this.prompt = { id: randomUUID(), ...prompt }; this.state = 'waiting';
      const timer = setTimeout(() => { this.prompt = null; this.state = 'running'; reject(new Error('等待操作已超时，可以重新开始；已有配置会保留。')); }, 30 * 60000);
      timer.unref();
      this.answer = value => { clearTimeout(timer); this.prompt = null; this.state = 'running'; resolveAnswer(value); };
      this.rejectPrompt = () => { clearTimeout(timer); this.prompt = null; this.state = 'cancelled'; reject(new Error('已退出本次操作，已保存的配置仍保留。')); };
    });
  }
  respond(id, value) {
    if (!this.prompt || id !== this.prompt.id || typeof value !== 'string' || value.length > 4096) throw new Error('这一步已失效，请刷新页面查看当前进度。');
    if (this.prompt.type === 'choice' && !Object.hasOwn(this.prompt.options, value)) throw new Error('请选择当前页面上的选项。');
    if (this.prompt.secret && value) this.privateValues.push(value);
    this.answer(value.trim());
  }
  async showQr(text, expiresAt) {
    const QRCode = require('qrcode-terminal/vendor/QRCode');
    const qr = new QRCode(-1, 1); qr.addData(text); qr.make();
    this.qr = { modules: qr.modules, expiresAt };
  }
  suspend() {}
  resume() {}
  close() { this.rejectPrompt?.(); }
  snapshot() {
    return { state: this.state, label: this.label, startedAt: this.startedAt, logs: this.logs,
      prompt: this.prompt, guidance: this.guidance, qr: this.qr?.expiresAt > Date.now() ? this.qr : null, error: this.error, restart: this.restart };
  }
  async cloud(root, args, { input, outputFile } = {}) {
    if (input) {
      try { this.privateValues.push(...Object.values(JSON.parse(input)).filter(v => typeof v === 'string')); } catch { this.privateValues.push(input); }
    }
    for (;;) {
      let output = '';
      const code = await this.task(args[0] === 'login' ? '请在新打开的 Cloudflare 页面完成授权' : args[0] === 'deploy' ? '正在更新云端程序' : '正在保存云端配置', () => new Promise((done, reject) => {
        const child = spawn(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), ...args], {
          cwd: root, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'false', NO_COLOR: '1',
            ...(outputFile ? { WRANGLER_OUTPUT_FILE_PATH: outputFile } : {}),
            ...(this.account ? { CLOUDFLARE_ACCOUNT_ID: this.account } : {}) },
        });
        this.child = child;
        const append = c => { const text = this.clean(c); output = (output + text).slice(-20000); this.logRaw(text); };
        child.stdout.setEncoding('utf8').on('data', append); child.stderr.setEncoding('utf8').on('data', append);
        child.stdin.on('error', () => {}); child.stdin.end(input === undefined ? '' : input + '\n');
        child.on('error', () => reject(new Error('无法启动云端组件，请重新打开网页入口。')));
        child.on('exit', code => { this.child = null; done(code); });
      }));
      if (code === 0) return;
      const dashboard = output.match(/https:\/\/dash\.cloudflare\.com\/[a-f0-9]{32}\/workers\/onboarding/);
      if (args[0] === 'deploy' && dashboard) {
        this.log('首次开通需要在 Cloudflare 给免费网址起一个名字：' + dashboard[0]);
        if (await this.choose('在上面的 Cloudflare 页面开通 workers.dev 免费网址，完成后继续。已有微信设置会保留。', { 1: '已经开通，继续部署', 0: '稍后继续' }, '1') === '1') continue;
      }
      const accounts = [...output.matchAll(/`([^`\n]+)`:\s*`([a-f0-9]{32})`/g), ...output.matchAll(/(?:│|\|)\s*([^│|\n]+?)\s*(?:│|\|)\s*([a-f0-9]{32})\s*(?:│|\|)/g)];
      if (accounts.length > 1) {
        const options = Object.fromEntries(accounts.map((m, i) => [String(i + 1), m[1].trim()])); options[0] = '返回';
        const selected = await this.choose('你的 Cloudflare 有多个账号，选择工具所在的账号。', options);
        if (selected !== '0') { this.account = accounts[Number(selected) - 1][2]; continue; }
      }
      throw new Error('云端操作未完成。请展开操作详情查看 Cloudflare 提示，处理后重试，已有配置会保留。');
    }
  }
}
