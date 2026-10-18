import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import { windowsFetch } from '../scripts/lib/network.mjs';
import { Progress, withProgress } from '../scripts/lib/progress.mjs';
import { api } from '../scripts/lib/client.mjs';

test('Windows transport preserves auth/body/HTTP errors without putting secrets in process arguments', { skip: process.platform !== 'win32' }, async () => {
  let received;
  let redirected = false;
  const server = createServer(async (req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/unexpected' }); res.end(); return; }
    if (req.url === '/unexpected') redirected = true;
    let body = '';
    for await (const chunk of req) body += chunk.toString('utf8');
    received = { auth: req.headers.authorization, body: JSON.parse(body) };
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'unauthorized', note: '中文响应' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = `http://127.0.0.1:${server.address().port}`;
  try {
    const marker = 'synthetic-admin-not-a-real-secret';
    const response = await windowsFetch(address + '/status', {
      method: 'POST', headers: { Authorization: 'Bearer ' + marker, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '中文消息' }),
    }, { spawnProcess: (command, args, options) => {
      assert.ok(!args.join(' ').includes(marker));
      assert.equal(options.windowsHide, true);
      return spawn(command, args, options);
    } });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).note, '中文响应');
    assert.deepEqual(received, { auth: 'Bearer ' + marker, body: { message: '中文消息' } });
    const redirect = await windowsFetch(address + '/redirect');
    assert.equal(redirect.status, 302); assert.equal(redirected, false);
  } finally { server.closeAllConnections(); server.close(); await once(server, 'close'); }
});

test('Windows request cancellation returns promptly and does not expose native exception text', { skip: process.platform !== 'win32' }, async () => {
  const started = Date.now();
  await assert.rejects(() => windowsFetch('https://example.invalid', { signal: AbortSignal.timeout(100) }), error => {
    assert.equal(error.code, 'ETIMEDOUT'); assert.ok(!error.message.includes('example.invalid')); return true;
  });
  assert.ok(Date.now() - started < 5000);
});

test('network errors identify proxy/DNS/timeout without suggesting every failure is new DNS', async () => {
  const profile = { url: 'https://tibo-wechat-reset-alert.example.workers.dev', admin: 'synthetic' };
  for (const [code, expected] of [['ETIMEDOUT', /超时/], ['ENOTFOUND', /解析/], ['CERTIFICATE_FAILED', /证书/], ['ECONNREFUSED', /系统代理/]]) {
    await assert.rejects(() => api(profile, '/status', undefined, async () => { throw Object.assign(new Error('sensitive-native-detail'), { code }); }), error => {
      assert.equal(error.code, 'connection_failed'); assert.match(error.message, expected);
      assert.ok(!error.message.includes('sensitive-native-detail')); return true;
    });
  }
});

test('spinner animates while an operation runs and clears itself after success', async () => {
  let output = '';
  const stream = new Writable({ write(chunk, _encoding, next) { output += chunk.toString(); next(); } });
  const result = await withProgress('正在连接测试服务', async () => {
    await new Promise(resolve => setTimeout(resolve, 65)); return 42;
  }, { stream, inline: true, intervalMs: 10, timeoutMs: 30000 });
  assert.equal(result, 42);
  assert.ok((output.match(/已等待/g) || []).length >= 2);
  assert.match(output, /完成/); assert.match(output, /30 秒内超时/);
  const finished = output;
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(output, finished);
});

test('progress finishes truthfully on failure and stop is idempotent', async () => {
  let output = '';
  const stream = new Writable({ write(chunk, _encoding, next) { output += chunk.toString(); next(); } });
  await assert.rejects(() => withProgress('正在检查', async () => { throw new Error('simulated'); }, { stream, inline: false }), /simulated/);
  assert.match(output, /未完成/); assert.ok(!output.includes('[完成]'));
  const progress = new Progress('等待用户授权', { stream, inline: false });
  progress.stop(); const stopped = output; progress.stop(); progress.render();
  assert.equal(output, stopped); assert.ok(!output.includes('%'));
});
