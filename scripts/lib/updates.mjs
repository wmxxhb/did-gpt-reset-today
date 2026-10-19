import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { systemFetch } from './network.mjs';

const runFile = promisify(execFile);
export const REPOSITORY = 'https://github.com/wmxxhb/did-gpt-reset-today';
export function newer(a, b) {
  const parse = v => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const av = parse(a), bv = parse(b);
  if (!av || !bv) throw new Error('无法识别版本号，请使用源码下载链接更新。');
  for (let i = 0; i < 3; i++) if (av[i] !== bv[i]) return av[i] > bv[i];
  return false;
}
export async function latestVersion(fetcher = systemFetch) {
  const response = await fetcher('https://api.github.com/repos/wmxxhb/did-gpt-reset-today/commits/main', {
    headers: { Accept: 'application/vnd.github+json' }, redirect: 'error', signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error('暂时无法检查 GitHub 更新，请稍后重试。');
  const { sha } = await response.json();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('更新信息无效，已停止更新。');
  const pkg = await fetcher(`https://raw.githubusercontent.com/wmxxhb/did-gpt-reset-today/${sha}/package.json`, {
    redirect: 'error', signal: AbortSignal.timeout(30000),
  });
  if (!pkg.ok) throw new Error('暂时无法读取版本信息，请稍后重试。');
  const data = await pkg.json();
  if (data.name !== 'did-gpt-reset-today' || !/^\d+\.\d+\.\d+$/.test(data.version)) throw new Error('更新信息无效，已停止更新。');
  return { sha, version: data.version };
}

export async function updateLocal(root, sha) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('更新版本无效。');
  if (existsSync(join(root, '.git'))) {
    const { stdout: remote } = await runFile('git', ['remote', 'get-url', 'origin'], { cwd: root, windowsHide: true });
    if (remote.trim().replace(/\.git$/, '') !== REPOSITORY) throw new Error('仓库来源不同，请从项目 GitHub 页面手动更新。');
    const { stdout } = await runFile('git', ['status', '--porcelain'], { cwd: root, windowsHide: true });
    if (stdout.trim()) throw new Error('本机源码有未提交的修改，请保留修改后手动更新。');
    await runFile('git', ['fetch', 'origin', 'main'], { cwd: root, windowsHide: true, timeout: 60000 });
    try { await runFile('git', ['merge', '--ff-only', sha], { cwd: root, windowsHide: true }); }
    catch { throw new Error('无法直接更新当前分支，请在 Git 中处理后重试。'); }
  } else {
    if (process.platform !== 'win32') throw new Error('ZIP 自动更新当前支持 Windows。');
    try {
      await runFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', join(root, 'scripts', 'update-local.ps1'), '-Root', root, '-Commit', sha], { windowsHide: true, timeout: 90000 });
    } catch { throw new Error('本机更新未完成，原有配置已保留。请检查网络后重试，或从项目 GitHub 页面下载新版。'); }
  }
}
