import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const sha = 'a'.repeat(40);
const helper = fileURLToPath(new URL('../scripts/update-local.ps1', import.meta.url));
async function createZip(source, zip) {
  const script = '$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.IO.Compression; Add-Type -AssemblyName System.IO.Compression.FileSystem; $p=ConvertFrom-Json ([Console]::In.ReadToEnd()); [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($p.zip)); $z=[IO.Compression.ZipFile]::Open($p.zip,[IO.Compression.ZipArchiveMode]::Create); try { Get-ChildItem -LiteralPath $p.source -Recurse -File -Force | ForEach-Object { $n=$_.FullName.Substring($p.source.Length+1).Replace([char]92,[char]47); [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($z,$_.FullName,$n) | Out-Null } } finally { $z.Dispose() }';
  const { spawn } = await import('node:child_process');
  await new Promise((resolveRun, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let error = ''; child.stderr.on('data', data => { error += data; }); child.stdout.resume();
    child.on('error', reject); child.on('close', code => code ? reject(new Error(error)) : resolveRun());
    child.stdin.end(JSON.stringify({ source, zip }));
  });
}

test('ZIP updater changes runtime files while preserving private settings, Git metadata and unrelated files', { skip: process.platform !== 'win32' }, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'gpt-reset-update-test-'));
  try {
    const root = join(folder, 'installed'), source = join(folder, 'archive');
    const prefix = join(source, 'did-gpt-reset-today-' + sha);
    for (const directory of [join(root, '.tibo-local'), join(root, '.git'), join(root, 'src'), join(prefix, 'src'), join(prefix, '.tibo-local')]) await mkdir(directory, { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'did-gpt-reset-today', version: '0.1.0' }));
    await writeFile(join(root, '.tibo-local', 'profile.dat'), 'synthetic-private-profile');
    await writeFile(join(root, '.git', 'marker'), 'synthetic-git-metadata');
    await writeFile(join(root, 'personal.txt'), 'keep-personal-file');
    await writeFile(join(root, 'src', 'worker.mjs'), 'old-worker');
    await writeFile(join(prefix, 'package.json'), JSON.stringify({ name: 'did-gpt-reset-today', version: '0.2.0' }));
    await writeFile(join(prefix, 'src', 'worker.mjs'), 'new-worker');
    await writeFile(join(prefix, '.tibo-local', 'profile.dat'), 'must-not-copy');
    const zip = join(folder, 'fixture.zip'); await createZip(source, zip);
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
      '-Root', root, '-Commit', sha, '-SourceArchive', zip], { windowsHide: true });
    assert.equal(await readFile(join(root, 'src', 'worker.mjs'), 'utf8'), 'new-worker');
    assert.equal(await readFile(join(root, '.tibo-local', 'profile.dat'), 'utf8'), 'synthetic-private-profile');
    assert.equal(await readFile(join(root, '.git', 'marker'), 'utf8'), 'synthetic-git-metadata');
    assert.equal(await readFile(join(root, 'personal.txt'), 'utf8'), 'keep-personal-file');
    // A missing/wrong archive root must not change the installed files.
    await assert.rejects(() => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
      '-Root', root, '-Commit', 'b'.repeat(40), '-SourceArchive', zip], { windowsHide: true }));
    assert.equal(await readFile(join(root, 'src', 'worker.mjs'), 'utf8'), 'new-worker');
  } finally {
    assert.ok(resolve(folder).startsWith(resolve(join(tmpdir(), 'gpt-reset-update-test-'))));
    await rm(folder, { recursive: true, force: true });
  }
});
