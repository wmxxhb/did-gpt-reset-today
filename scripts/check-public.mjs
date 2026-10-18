import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RULES = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['github-token', /\b(?:gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{30,})\b/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['bearer-jwt', /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g],
  ['long-hex-literal', /["'][a-fA-F0-9]{32,}["']/g],
];

export function inspectPublicFile(path, text) {
  const normalized = path.replaceAll('\\', '/');
  const segments = normalized.split('/');
  const base = segments.at(-1);
  const findings = [];
  if (segments.some(s => ['.tibo-local', '.wrangler', 'node_modules', 'dist'].includes(s))
    || (/^(?:\.env|\.dev\.vars)(?:\.|$)/.test(base) && !base.endsWith('.example'))
    || /\.(?:dat|pem|key|p12|pfx|log)$/i.test(base)) {
    findings.push({ path: normalized, rule: 'private-or-generated-file', line: 1 });
  }
  // Dependency lock integrity hashes are public package checksums, not credentials.
  const content = base === 'package-lock.json' ? text.replace(/^.*"integrity".*$/gm, '') : text;
  for (const [rule, pattern] of RULES) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      findings.push({ path: normalized, rule, line: content.slice(0, match.index).split('\n').length });
    }
  }
  return findings;
}

async function main() {
  let names;
  try { names = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean); }
  catch { throw new Error('请在 Git 仓库根目录运行公开发布检查。'); }
  if (!names.length) throw new Error('没有待检查的 Git 文件；请先 git add，再执行检查。');
  const findings = [];
  for (const name of names) findings.push(...inspectPublicFile(name, await readFile(name, 'utf8')));
  if (findings.length) {
    // Never print the matched value: a failure report must not publish a secret.
    console.error(JSON.stringify({ ok: false, findings }, null, 2));
    process.exitCode = 1;
  } else console.log(`公开发布检查通过：${names.length} 个 Git 文件，未发现匹配的敏感项或私有运行文件。`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
