import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { stdin, stdout } from 'node:process';
import { withProgress } from './progress.mjs';

export class UI {
  constructor() {
    this.muted = false;
    this.output = new Writable({ write: (chunk, _encoding, next) => { if (!this.muted) stdout.write(chunk); next(); } });
    this.rl = createInterface({ input: stdin, output: this.output, terminal: !!stdin.isTTY });
  }
  async ask(prompt, secret = false) {
    if (!secret) return (await this.rl.question(prompt)).trim();
    stdout.write(prompt);
    this.muted = true;
    try { return (await this.rl.question('')).trim(); }
    finally { this.muted = false; stdout.write('\n'); }
  }
  async choose(title, options, fallback) {
    console.log('\n' + title);
    for (const [key, label] of Object.entries(options).sort(([a], [b]) => a === '0' ? 1 : b === '0' ? -1 : 0)) console.log(`  ${key}. ${label}`);
    while (true) {
      const answer = (await this.ask(fallback ? `输入选项编号，直接回车选 ${fallback}：` : '输入选项编号：')) || fallback;
      if (Object.hasOwn(options, answer)) return answer;
      console.log('请选择上方列出的编号。');
    }
  }
  task(label, callback, options) { return withProgress(label, callback, options); }
  suspend() { this.rl.pause(); if (stdin.isTTY) stdin.setRawMode(false); }
  resume() { if (stdin.isTTY) stdin.setRawMode(true); this.rl.resume(); }
  close() { this.rl.close(); }
}
