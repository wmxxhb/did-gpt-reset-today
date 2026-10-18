import { stdout } from 'node:process';

export class Progress {
  constructor(label, { stream = stdout, inline = !!stream.isTTY, timeoutMs, intervalMs = 200, heartbeatMs = 10000, clock = () => Date.now() } = {}) {
    this.label = label; this.stream = stream; this.inline = inline; this.timeoutMs = timeoutMs;
    this.clock = clock; this.started = clock(); this.frame = 0; this.stopped = false; this.lastHeartbeat = this.started;
    this.render(true);
    this.timer = setInterval(() => {
      if (this.inline || this.clock() - this.lastHeartbeat >= heartbeatMs) this.render();
    }, intervalMs);
    this.timer.unref?.();
  }
  render() {
    if (this.stopped) return;
    const seconds = Math.floor((this.clock() - this.started) / 1000);
    const spinner = ['|', '/', '-', '\\'][this.frame++ % 4];
    const limit = this.timeoutMs ? `，约 ${Math.ceil(this.timeoutMs / 1000)} 秒内超时返回` : '';
    const text = `[${spinner}] ${this.label} · 已等待 ${seconds} 秒${limit}`;
    this.stream.write(this.inline ? `\r\x1b[2K${text}` : `${text}\n`);
    this.lastHeartbeat = this.clock();
  }
  stop(ok = true) {
    if (this.stopped) return;
    this.stopped = true; clearInterval(this.timer);
    const seconds = Math.ceil((this.clock() - this.started) / 1000);
    const text = `[${ok ? '完成' : '未完成'}] ${this.label}（耗时 ${seconds} 秒）\n`;
    this.stream.write((this.inline ? '\r\x1b[2K' : '') + text);
  }
}

export async function withProgress(label, task, options) {
  const progress = new Progress(label, options);
  try { const result = await task(); progress.stop(true); return result; }
  catch (error) { progress.stop(false); throw error; }
}
