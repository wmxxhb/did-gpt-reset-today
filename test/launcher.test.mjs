import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const name = '打开工具.cmd';

// GitHub source archives contain Git blobs, not Windows checkout conversions.
function archivedLauncher(fallback) {
  if (!existsSync(join(root, '.git'))) return fallback;
  return execFileSync('git', ['show', `:${name}`], { cwd: root });
}

test('downloaded Windows launcher preserves CRLF without a UTF-8 BOM', async () => {
  const checkout = await readFile(join(root, name));
  for (const content of [checkout, archivedLauncher(checkout)]) {
    assert.equal(content.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false);
    const text = content.toString('utf8');
    assert.ok(text.includes('\r\n'));
    assert.doesNotMatch(text.replaceAll('\r\n', ''), /[\r\n]/);
  }
});

test('source archive launcher starts PowerShell from a path with spaces and Chinese', { skip: process.platform !== 'win32' }, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'GPT 启动测试 '));
  try {
    const content = archivedLauncher(await readFile(join(root, name)));
    const launcher = join(folder, name);
    await writeFile(launcher, content);
    // Only test the launcher: never install, deploy or use real credentials.
    await writeFile(join(folder, '启动部署.ps1'), "\ufeffWrite-Output 'LAUNCH_OK'\r\nexit 0\r\n");
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${launcher}""`], {
      windowsVerbatimArguments: true, input: '\r\n', encoding: 'utf8', timeout: 20000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /LAUNCH_OK/);
    assert.equal(result.stderr.trim(), '');
  } finally {
    assert.ok(resolve(folder).startsWith(resolve(join(tmpdir(), 'GPT 启动测试 '))));
    await rm(folder, { recursive: true, force: true });
  }
});
