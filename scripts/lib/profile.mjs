import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Windows DPAPI binds the encrypted credential to the current Windows user.
async function dpapi(value, decrypt = false) {
  if (process.platform !== 'win32') throw new Error('本机凭据保存目前支持 Windows；请在 Windows 运行中文向导。');
  const code = `[Console]::InputEncoding = [Text.Encoding]::UTF8; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $ErrorActionPreference='Stop'; [void][Reflection.Assembly]::LoadWithPartialName('System.Security'); `
    + (decrypt
      ? `$b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Text.Encoding]::UTF8.GetString($p))`
      : `$b=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); $p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($p))`);
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let result = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', c => { result += c; });
    child.stderr.resume();
    child.on('error', () => reject(new Error('无法使用 Windows 本机凭据加密。')));
    child.on('exit', code => code === 0 ? resolve(result.replace(/^\uFEFF/, '')) : reject(new Error('本机凭据无法读取，请使用原 Windows 账号，或从菜单重新接管工具。')));
    child.stdin.on('error', () => {});
    child.stdin.end(value);
  });
}

export async function saveProfile(root, profile) {
  const file = join(root, '.tibo-local', 'profile.dat');
  const encrypted = await dpapi(JSON.stringify(profile));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file + '.tmp', encrypted, { mode: 0o600 });
  await rename(file + '.tmp', file);
}

export async function loadProfile(root) {
  let encrypted;
  try { encrypted = await readFile(join(root, '.tibo-local', 'profile.dat'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return JSON.parse(await dpapi(encrypted, true));
}
