import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('Cloudflare runtime routes the optional actor and can generate a QR without exposing credentials', async () => {
  let calls = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'clawbot-runtime-test',
    modules: ['worker', 'monitor', 'classify', 'settings', 'clawbot', 'version', 'reset-history'].map(name => ({
      type: 'ESModule', path: fileURLToPath(new URL(`../src/${name}.mjs`, import.meta.url)),
    })),
    compatibilityDate: '2025-10-01',
    bindings: { ADMIN_TOKEN: 'synthetic-runtime-admin-for-tests-only' },
    durableObjects: { MONITOR: { className: 'ResetMonitor', useSQLite: true } },
    outboundService: async request => {
      calls++;
      if (request.url.includes('/get_qrcode_status?')) return Response.json({ status: 'confirmed',
        bot_token: 'synthetic-runtime-token', ilink_user_id: 'synthetic-runtime-owner', ilink_bot_id: 'synthetic-runtime-bot' });
      if (request.url.endsWith('/getupdates')) return Response.json({ ret: 0, msgs: [{ from_user_id: 'synthetic-runtime-owner',
        message_type: 1, create_time_ms: Date.now(), context_token: 'synthetic-runtime-context' }] });
      if (request.url.endsWith('/sendmessage')) {
        assert.equal(request.headers.get('Authorization'), 'Bearer synthetic-runtime-token');
        return Response.json({ message_id: 'synthetic-runtime-message' });
      }
      assert.equal(request.url, 'https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3');
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.get('iLink-App-Id'), 'bot');
      assert.equal(request.headers.get('Authorization'), null);
      const body = await request.json();
      assert.deepEqual(body.local_token_list, []);
      return Response.json({ ret: 0, qrcode: 'synthetic-runtime-qr', qrcode_img_content: 'https://example.com/synthetic-runtime-qr' });
    },
  }] }));
  const headers = { Authorization: 'Bearer synthetic-runtime-admin-for-tests-only' };
  try {
    assert.equal((await mf.dispatchFetch('https://example.com/clawbot/status')).status, 401);
    const before = await (await mf.dispatchFetch('https://example.com/clawbot/status', { headers })).json();
    assert.equal(before.state, 'disabled'); assert.equal(calls, 0);
    const response = await mf.dispatchFetch('https://example.com/clawbot/login/start', { method: 'POST', headers, body: '{}' });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.ok(result.id); assert.ok(result.qrContent); assert.equal(calls, 1);
    const after = await (await mf.dispatchFetch('https://example.com/clawbot/status', { headers })).json();
    assert.equal(after.state, 'disabled');
    assert.ok(!JSON.stringify(after).includes('synthetic-runtime-qr'));
    const send = (path, body = {}) => mf.dispatchFetch('https://example.com' + path, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal((await send('/clawbot/login/poll', { id: result.id })).status, 200);
    assert.equal((await (await send('/clawbot/refresh')).json()).state, 'ready');
    const testResult = await send('/clawbot/test');
    assert.equal(testResult.status, 200, await testResult.text());
    assert.equal((await send('/pause')).status, 200, 'pause must synchronize independent actors');
    assert.equal((await send('/resume')).status, 200);
    assert.equal((await send('/clawbot/toggle', { enabled: false })).status, 200);
    const main = await (await mf.dispatchFetch('https://example.com/status', { headers })).json();
    assert.equal(main.service.enabled, false, 'chat-only never requires a service token');
    assert.equal(main.version, '0.4.0');
  } finally { await mf.dispose(); }
});
