import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localRequest } from '../web/client.mjs';

test('a closed local server tells the user to reopen the launcher instead of leaking a raw fetch error', async () => {
  await assert.rejects(() => localRequest('overview', undefined, async () => { throw new TypeError('Failed to fetch'); }), error => {
    assert.equal(error.code, 'local_unreachable'); assert.match(error.message, /本机网页后台已断开/);
    assert.match(error.message, /自动打开的新页面/); assert.match(error.message, /旧标签页/);
    assert.ok(!error.message.includes('Failed to fetch')); return true;
  });
});

test('local timeouts are distinguished from a stopped server', async () => {
  await assert.rejects(() => localRequest('overview', undefined, async () => { throw new DOMException('timeout', 'TimeoutError'); }), error => {
    assert.equal(error.code, 'local_timeout'); assert.match(error.message, /响应超时/); return true;
  });
});

test('cloud and session errors from a reachable backend retain their real explanation', async () => {
  await assert.rejects(() => localRequest('overview', undefined, async () => Response.json({ error: 'synthetic cloud error' }, { status: 400 })), error => {
    assert.equal(error.code, 'api_error'); assert.equal(error.message, 'synthetic cloud error'); return true;
  });
  await assert.rejects(() => localRequest('overview', undefined, async () => Response.json({ error: 'reopen' }, { status: 401 })), error => error.code === 'local_session_expired');
});

test('the browser client preserves same-origin credentials and bounds latency without retrying mutations', async () => {
  let calls = 0;
  const result = await localRequest('request', { path: '/pause', body: {} }, async (path, options) => {
    calls++; assert.equal(path, '/api/request'); assert.equal(options.method, 'POST'); assert.equal(options.credentials, 'same-origin');
    assert.equal(options.headers['Content-Type'], 'application/json'); assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(options.body), { path: '/pause', body: {} }); return Response.json({ ok: true });
  });
  assert.equal(result.ok, true); assert.equal(calls, 1);
  await assert.rejects(() => localRequest('overview', undefined, async () => new Response('<html>bad</html>')), error => error.code === 'invalid_response');
});
