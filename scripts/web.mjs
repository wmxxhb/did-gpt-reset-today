import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createManager } from './manage.mjs';
import { WebUI } from './lib/web-ui.mjs';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'], '/icons.svg': ['icons.svg', 'image/svg+xml'] };
const operations = new Set(['setup', 'connect', 'recover', 'continue', 'service', 'chat', 'test', 'test-service', 'test-chat', 'updates']);
const requests = new Set(['/check', '/settings', '/channels', '/pause', '/resume', '/clawbot/toggle', '/clawbot/refresh', '/clawbot/disable']);
const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function startWeb({ root = defaultRoot, port = 0, managerFactory = createManager } = {}) {
  const launchToken = randomBytes(32).toString('base64url'), session = randomBytes(32).toString('base64url');
  let origin, cookieName, job = null, writing = false, launchUsed = false;
  const manager = ui => managerFactory({ root, ui });
  const server = createServer(async (req, res) => {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
    const send = (data, status = 200, extra = {}) => { res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...extra }); res.end(JSON.stringify(data)); };
    try {
      if (req.headers.host !== new URL(origin).host) return send({ error: '无效的本机地址。' }, 403);
      const path = new URL(req.url, origin).pathname;
      if (req.method === 'GET' && assets[path]) {
        const [name, mime] = assets[path]; const content = await readFile(resolve(root, 'web', name));
        res.writeHead(200, { ...headers, 'Content-Type': mime }); return res.end(content);
      }
      if (!path.startsWith('/api/')) return send({ error: '没有这个页面。' }, 404);
      if (!['GET', 'POST'].includes(req.method)) return send({ error: '不支持的操作。' }, 405);
      if (req.method === 'POST' && req.headers.origin !== origin) return send({ error: '请从本机网页入口进行操作。' }, 403);
      let body;
      if (req.method === 'POST') {
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return send({ error: '请求格式无效。' }, 415);
        let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 16384) return send({ error: '请求过大。' }, 413); }
        try { body = JSON.parse(raw); } catch { return send({ error: '请求格式无效。' }, 400); }
        if (!body || Array.isArray(body) || typeof body !== 'object') return send({ error: '请求格式无效。' }, 400);
      }
      if (path === '/api/session' && req.method === 'POST') {
        if (launchUsed || !equal(body.token, launchToken)) return send({ error: '请重新双击“打开网页版.cmd”打开管理页面。' }, 401);
        launchUsed = true;
        return send({ ok: true }, 200, { 'Set-Cookie': `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/` });
      }
      const cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
      if (!equal(cookie, session)) return send({ error: '尚未连接本机管理页面，请重新双击“打开网页版.cmd”。' }, 401);
      if (path === '/api/overview' && req.method === 'GET') return send(await manager(new WebUI()).overview());
      if (path === '/api/job' && req.method === 'GET') return send(job?.snapshot() || null);
      if (path === '/api/reply' && req.method === 'POST') { if (!job) return send({ error: '当前没有进行中的操作。' }, 409); job.respond(body.id, body.value); return send({ ok: true }); }
      if (path === '/api/cancel' && req.method === 'POST') {
        if (job?.state !== 'waiting') return send({ error: '当前步骤正在执行，请等待完成。' }, 409);
        job.rejectPrompt(); return send({ ok: true });
      }
      if (path === '/api/action' && req.method === 'POST') {
        if (!operations.has(body.action)) return send({ error: '操作无效。' }, 400);
        if (writing || job && ['running', 'waiting'].includes(job.state)) return send({ error: '请先完成当前操作。' }, 409);
        const ui = new WebUI(); job = ui;
        manager(ui).run(body.action).then(result => { ui.restart = result === 'restart'; ui.state = 'done'; ui.label = '操作已完成'; })
          .catch(error => { ui.state = 'failed'; ui.error = ui.clean(error.message); })
          .finally(() => { ui.qr = null; ui.privateValues = []; });
        return send({ ok: true }, 202);
      }
      if (path === '/api/request' && req.method === 'POST') {
        if (!requests.has(body.path)) return send({ error: '操作无效。' }, 400);
        if (writing || job && ['running', 'waiting'].includes(job.state)) return send({ error: '请先完成当前操作。' }, 409);
        writing = true;
        try { return send(await manager(new WebUI()).request(body.path, body.body || {})); }
        finally { writing = false; }
      }
      return send({ error: '操作不存在。' }, 404);
    } catch (error) { send({ error: error.message || '操作未完成，请稍后重试。' }, 400); }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  origin = `http://127.0.0.1:${server.address().port}`; cookieName = `gpt_reset_${server.address().port}`;
  return { server, origin, launchToken, url: `${origin}/#${launchToken}`, close() { job?.close(); job?.child?.kill(); server.closeAllConnections(); return new Promise(done => server.close(done)); } };
}

function openBrowser(url) {
  if (process.platform !== 'win32') return;
  const code = `Start-Process '${url}'`;
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' });
  child.on('error', () => console.log('浏览器未自动打开，请复制上面的地址。'));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await startWeb();
  console.log('GPT今天重置了吗？ · 网页版\n' + app.url + '\n浏览器会自动打开。请保留此窗口；关闭后云端监控继续运行。');
  if (!process.argv.includes('--no-open')) openBrowser(app.url);
  process.on('SIGINT', async () => { await app.close(); process.exit(0); });
}
