import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('Cloudflare runtime routes the optional actor and can generate a QR without exposing credentials', async () => {
  let calls = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'clawbot-runtime-test',
    modules: ['worker', 'monitor', 'classify', 'settings', 'clawbot'].map(name => ({
      type: 'ESModule', path: fileURLToPath(new URL(`../src/${name}.mjs`, import.meta.url)),
    })),
    compatibilityDate: '2025-10-01',
    bindings: { ADMIN_TOKEN: 'synthetic-runtime-admin-for-tests-only' },
    durableObjects: { MONITOR: { className: 'ResetMonitor', useSQLite: true } },
    outboundService: async request => {
      calls++;
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
  } finally { await mf.dispose(); }
});
