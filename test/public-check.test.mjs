import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectPublicFile } from '../scripts/check-public.mjs';

test('public check flags secret formats without including secret contents in its report', () => {
  const synthetic = ['ghp_' + 'a'.repeat(30), '"' + 'f'.repeat(64) + '"', '-----BEGIN ' + 'PRIVATE KEY-----'];
  for (const value of synthetic) {
    const findings = inspectPublicFile('src/example.mjs', value);
    assert.ok(findings.length > 0);
    assert.ok(!JSON.stringify(findings).includes(value));
  }
});

test('public check rejects private runtime files and accepts explicit examples', () => {
  for (const path of ['.tibo-local/profile.dat', '.wrangler/state/config.json', '.env.local', '.dev.vars', 'node_modules/package/index.js']) {
    assert.ok(inspectPublicFile(path, '{}').some(f => f.rule === 'private-or-generated-file'));
  }
  assert.deepEqual(inspectPublicFile('.dev.vars.example', 'XTUIS_TOKEN=your_xtuis_token'), []);
  assert.deepEqual(inspectPublicFile('README.md', 'https://example.workers.dev'), []);
});
