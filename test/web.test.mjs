import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startWeb } from '../scripts/web.mjs';
import { WebUI } from '../scripts/lib/web-ui.mjs';
import { createManager } from '../scripts/manage.mjs';
import { request as httpRequest } from 'node:http';

const root = resolve(import.meta.dirname, '..');
async function connect(app) {
  const response = await fetch(app.origin + '/api/session', { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: app.launchToken }) });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}
const post = (app, cookie, path, body) => fetch(app.origin + '/api/' + path, { method: 'POST', headers: { Origin: app.origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('local website requires a one-time launch key, same-origin writes, and rejects rebinding and private file access', async () => {
  const app = await startWeb({ root, managerFactory: () => ({ async overview() { return { connected: false }; } }) });
  try {
    assert.equal(app.server.address().address, '127.0.0.1');
    const page = await fetch(app.origin); assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal((await fetch(app.origin + '/api/overview')).status, 401);
    assert.equal((await fetch(app.origin + '/.tibo-local/profile.dat')).status, 404);
    const badHost = await new Promise((done, reject) => {
      const req = httpRequest(app.origin, { headers: { Host: 'attacker.example' } }, res => { res.resume(); done(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(badHost, 403);
    assert.equal((await fetch(app.origin + '/api/session', { method: 'POST', headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: app.launchToken }) })).status, 403);
    const cookie = await connect(app);
    assert.deepEqual(await (await fetch(app.origin + '/api/overview', { headers: { Cookie: cookie } })).json(), { connected: false });
    assert.equal((await post(app, cookie, 'session', { token: app.launchToken })).status, 401);
    assert.equal((await post(app, cookie, 'request', { path: 'https://attacker.example', body: {} })).status, 400);
    assert.equal((await post(app, cookie, 'request', { path: '/clawbot/tick' })).status, 400);
    const cross = await fetch(app.origin + '/api/request', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://attacker.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/pause' }) });
    assert.equal(cross.status, 403);
    assert.equal(cross.headers.get('access-control-allow-origin'), null);
  } finally { await app.close(); }
});

test('website reuses manager workflows, hides secret replies and serializes changes while a workflow is active', async () => {
  const calls = [];
  const app = await startWeb({ root, managerFactory: ({ ui }) => ({
    async overview() { return { connected: false }; },
    async request(path, body) { calls.push({ path, body }); return { ok: true }; },
    async run(action) {
      calls.push(action);
      const answer = await ui.choose('choose', { 1: 'continue', 0: 'back' }, '1'); assert.equal(answer, '1');
      const secret = await ui.ask('secret', true); ui.log('Received ' + secret);
    },
  }) });
  try {
    const cookie = await connect(app);
    const current = async () => (await fetch(app.origin + '/api/job', { headers: { Cookie: cookie } })).json();
    assert.equal((await post(app, cookie, 'action', { action: 'setup' })).status, 202);
    let job = await current(); assert.equal(job.prompt.type, 'choice');
    assert.equal((await post(app, cookie, 'action', { action: 'test' })).status, 409);
    assert.equal((await post(app, cookie, 'request', { path: '/pause' })).status, 409);
    assert.equal((await post(app, cookie, 'reply', { id: job.prompt.id, value: 'arbitrary' })).status, 400);
    await post(app, cookie, 'reply', { id: job.prompt.id, value: '1' }); job = await current();
    assert.equal(job.prompt.secret, true); const secret = 'synthetic-private-value';
    await post(app, cookie, 'reply', { id: job.prompt.id, value: secret }); job = await current();
    assert.equal(job.state, 'done'); assert.ok(!JSON.stringify(job).includes(secret)); assert.match(job.logs[0], /已隐藏/);
    await post(app, cookie, 'request', { path: '/settings', body: { alerts: 'completed', banked: false } });
    assert.deepEqual(calls, ['setup', { path: '/settings', body: { alerts: 'completed', banked: false } }]);
    assert.equal((await post(app, cookie, 'reply', { id: 'old', value: '1' })).status, 400);
  } finally { await app.close(); }
});

test('reopening the webpage can resume a pending workflow, or cancel it without mutating settings', async () => {
  let cancelled = false;
  const app = await startWeb({ root, managerFactory: ({ ui }) => ({ async run() { try { await ui.ask('next'); } catch { cancelled = true; throw new Error('Cancelled'); } } }) });
  try {
    const cookie = await connect(app); await post(app, cookie, 'action', { action: 'connect' });
    const state = await (await fetch(app.origin + '/api/job', { headers: { Cookie: cookie } })).json();
    assert.equal(state.state, 'waiting'); assert.equal(state.prompt.title, 'next');
    assert.equal((await post(app, cookie, 'cancel', {})).status, 200); assert.equal(cancelled, true);
  } finally { await app.close(); }
});

test('web QR generation is local and does not put the authorization URL in the browser state', async () => {
  const ui = new WebUI(); await ui.showQr('https://example.com/synthetic-qr-secret', Date.now() + 300000);
  const state = ui.snapshot(); assert.ok(state.qr.modules.length > 20);
  assert.ok(state.qr.modules.flat().every(cell => typeof cell === 'boolean'));
  assert.ok(!JSON.stringify(state).includes('synthetic-qr-secret'));
  ui.qr.expiresAt = 0; assert.equal(ui.snapshot().qr, null);
});

test('web Cloudflare operation streams output and supports missing-domain onboarding without terminal input', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'reset-web-cloud-'));
  try {
    await mkdir(join(folder, 'node_modules/wrangler/bin'), { recursive: true });
    const cli = `const fs=require('node:fs');const path=require('node:path');const p=path.join(process.cwd(),'marker');if(!fs.existsSync(p)){fs.writeFileSync(p,'ok');console.log('Register a subdomain: https://dash.cloudflare.com/'+ 'a'.repeat(32)+'/workers/onboarding');process.exitCode=1;}else console.log('Deployment complete');`;
    await writeFile(join(folder, 'node_modules/wrangler/bin/wrangler.js'), cli);
    const ui = new WebUI(); const result = ui.cloud(folder, ['deploy']);
    while (!ui.prompt) await new Promise(done => setTimeout(done, 10));
    assert.equal(ui.state, 'waiting'); assert.match(ui.prompt.title, /免费网址/);
    ui.respond(ui.prompt.id, '1'); await result;
    assert.match(ui.logs.join('\n'), /Deployment complete/);
  } finally { assert.ok(folder.startsWith(join(tmpdir(), 'reset-web-cloud-'))); await rm(folder, { recursive: true, force: true }); }
});

test('terminal manager import is side-effect free, and both Windows launchers preserve CRLF', async () => {
  assert.equal(typeof createManager, 'function');
  for (const name of ['打开工具.cmd', '打开网页版.cmd']) {
    const content = await readFile(join(root, name), 'utf8');
    assert.doesNotMatch(content, /[^\x00-\x7f]/); assert.doesNotMatch(content.replaceAll('\r\n', ''), /[\r\n]/);
    if (name.includes('网页')) assert.match(content, /-Web/);
  }
});

test('web deployment lets the user choose among Cloudflare accounts without editing files', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'reset-web-accounts-'));
  try {
    await mkdir(join(folder, 'node_modules/wrangler/bin'), { recursive: true });
    const cli = "if(!process.env.CLOUDFLARE_ACCOUNT_ID){console.log('More than one account available\\n`First`: `'+'a'.repeat(32)+'`\\n`Second`: `'+'b'.repeat(32)+'`');process.exitCode=1;}else console.log('Selected '+process.env.CLOUDFLARE_ACCOUNT_ID);";
    await writeFile(join(folder, 'node_modules/wrangler/bin/wrangler.js'), cli);
    const ui = new WebUI(), run = ui.cloud(folder, ['deploy']);
    while (!ui.prompt) await new Promise(done => setTimeout(done, 10));
    assert.equal(ui.prompt.options['2'], 'Second'); ui.respond(ui.prompt.id, '2'); await run;
    assert.equal(ui.account, 'b'.repeat(32));
  } finally { assert.ok(folder.startsWith(join(tmpdir(), 'reset-web-accounts-'))); await rm(folder, { recursive: true, force: true }); }
});

test('shared first-use workflow completes all four notification modes with only selected channels configured', async () => {
  for (const mode of ['1', '2', '3', '4']) {
    const folder = await mkdtemp(join(tmpdir(), 'reset-web-setup-'));
    let saved = null, serviceEnabled = false, chatConfigured = false; const uploaded = [], calls = [], qrCodes = [];
    const choices = [mode, ...(['1', '3'].includes(mode) ? ['1'] : []), '1', ...(['2', '3'].includes(mode) ? ['1', '1'] : []), ...(['1', '2', '3'].includes(mode) ? ['0'] : [])];
    const ui = {
      browser: true, log() {}, async task(_label, callback) { return callback(); },
      async choose(_title, options) { const answer = choices.shift(); assert.ok(Object.hasOwn(options, answer)); return answer; },
      async ask(_title, secret) { assert.equal(secret, true); return 'synthetic-service-token'; },
      async showQr(content) { qrCodes.push(content); },
      async cloud(_root, args, { input, outputFile }) {
        if (args[0] === 'secret') uploaded.push(JSON.parse(input));
        if (outputFile) await writeFile(outputFile, JSON.stringify({ type: 'deploy', targets: ['https://tibo-wechat-reset-alert.synthetic-example.workers.dev'] }));
      },
    };
    const manager = createManager({ root: folder, ui, async readProfile() { return saved && structuredClone(saved); },
      async writeProfile(_root, value) { saved = structuredClone(value); },
      async client(profile, path, body) {
        assert.equal(profile.url, 'https://tibo-wechat-reset-alert.synthetic-example.workers.dev');
        calls.push({ path, body });
        if (path === '/channels') serviceEnabled = body.serviceEnabled;
        if (path === '/status') return { service: { enabled: serviceEnabled } };
        if (path === '/clawbot/status') return { enabled: chatConfigured, configured: chatConfigured, state: chatConfigured ? 'ready' : 'disabled' };
        if (path === '/clawbot/login/start') return { id: 'synthetic-login-id', qrContent: 'synthetic-qr', expiresAt: Date.now() + 10000 };
        if (path === '/clawbot/login/poll') { chatConfigured = true; return { status: 'confirmed' }; }
        if (path === '/clawbot/refresh') return { state: 'ready' };
        return {};
      },
    });
    try {
      await manager.run('setup');
      assert.equal(choices.length, 0); assert.equal(saved.setup, undefined); assert.equal(saved.admin.length, 64);
      assert.equal(serviceEnabled, ['1', '3'].includes(mode)); assert.equal(chatConfigured, ['2', '3'].includes(mode));
      assert.equal(!!uploaded[0].XTUIS_TOKEN, serviceEnabled); assert.equal(qrCodes.length, chatConfigured ? 1 : 0);
      assert.ok(calls.some(c => c.path === '/check')); assert.ok(!calls.some(c => c.path === '/test' || c.path === '/clawbot/test'));
    } finally { assert.ok(folder.startsWith(join(tmpdir(), 'reset-web-setup-'))); await rm(folder, { recursive: true, force: true }); }
  }
});

test('cloud connection failures retain local metadata and repair controls without exposing the admin key', async () => {
  const manager = createManager({ root, ui: new WebUI(), async readProfile() { return { url: 'https://example.workers.dev', admin: 'synthetic-private-admin', setup: { phase: 'settings' } }; },
    async client() { throw new Error('synthetic offline'); } });
  const result = await manager.overview();
  assert.equal(result.connected, true); assert.equal(result.setupPending, true); assert.equal(result.status, null);
  assert.equal(result.error, 'synthetic offline'); assert.ok(!JSON.stringify(result).includes('synthetic-private-admin'));
});
