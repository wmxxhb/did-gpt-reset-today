import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { deploymentUrl } from './client.mjs';

export async function wrangler(root, args, { ui, input, outputFile } = {}) {
  if (ui?.cloud) return ui.cloud(root, args, { input, outputFile });
  const cli = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
  ui?.suspend();
  try {
    const operation = () => new Promise((resolveRun, reject) => {
      const child = spawn(process.execPath, [cli, ...args], {
        cwd: root, shell: false,
        stdio: input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false', ...(outputFile ? { WRANGLER_OUTPUT_FILE_PATH: outputFile } : {}) },
      });
      if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input + '\n'); }
      child.on('error', () => reject(new Error('无法启动云端部署工具，请重新打开“打开工具”。')));
      child.on('exit', code => code === 0 ? resolveRun() : reject(new Error('云端操作未完成。你的已有绑定会保留，可检查上方提示后重试。')));
    });
    const label = args[0] === 'login' ? '等待浏览器完成 Cloudflare 授权，完成后自动继续'
      : args[0] === 'deploy' ? '正在部署云端程序' : '正在保存云端配置';
    if (ui?.task) await ui.task(label, operation, { inline: false });
    else await operation();
  } finally { ui?.resume(); }
}

export async function deploy(root, ui) {
  const folder = join(root, '.tibo-local');
  await mkdir(folder, { recursive: true });
  const outputFile = join(folder, 'deploy.ndjson');
  await writeFile(outputFile, '');
  (ui?.log || console.log)('\n正在更新云端程序，已有微信绑定和提醒记录会保留。');
  (ui?.log || console.log)(ui?.browser ? '首次开通如需注册免费网址，网页会提示打开 Cloudflare 页面，完成后点击继续。' : '首次开通若出现英文询问：是否注册免费网址选 yes；名称填 tibo-alert-加任意数字；最后确认选 yes。');
  (ui?.log || console.log)('这只是给免费网址起名，不需要购买域名。后续地址由向导自动识别。');
  await wrangler(root, ['deploy'], { ui, outputFile });
  const url = deploymentUrl(await readFile(outputFile, 'utf8'));
  return url;
}
