import { afterAll, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { ROOT_DIR } from '../lib/config';

const root = mkdtempSync(join(tmpdir(), 'mango-bun-fmt-'));
copyFileSync(join(ROOT_DIR, 'bunfig.toml'), join(root, 'bunfig.toml'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const fixtures: Record<string, string> = {
  'source.ts': 'export const value={answer:42};\n',
  'source.mts': 'export const value={answer:42};\n',
  'source.cts': 'export const value={answer:42};\n',
  'source.js': 'export const value={answer:42};\n',
  'source.jsx': 'export const element=<div title="answer">42</div>;\n',
  'source.tsx': 'export const element=<div title="answer">42</div>;\n',
  'source.mjs': 'export const value={answer:42};\n',
  'source.cjs': 'exports.value={answer:42};\n',
  'source.json': '{"answer":42}\n',
  'source.jsonc': '// comment\n{"answer":42}\n',
  'source.css': '.answer{color:red}\n',
  'source.html': '<div   title="answer">42</div>\n',
  'source.md': '#    Answer\n',
  'source.mdc': '#    Answer\n',
  'source.mdx': '#    Answer\n',
  'source.toml': 'answer=42\n',
  'source.yml': 'answer:   42\n',
  'source.yaml': 'answer:   42\n',
};
const preserved: Record<string, string> = {
  'CHANGELOG.md': '#    Generated changelog\n',
  'apps/frontend/src/routeTree.gen.ts': 'export const value={answer:42};\n',
  'apps/shared/src/runtime-contract/generated/example.ts': 'export const value={answer:42};\n',
  'spec/fixtures/example.json': '{"wire":42}\n',
  'crates/mangostudio-runtime/tests/fixtures/example.json': '{"wire":42}\n',
  '.mango/artifacts/example.json': '{"wire":42}\n',
  '.mango/out/example.ts': 'export const value={answer:42};\n',
  Dockerfile: 'FROM alpine\nRUN   echo hello\n',
};

test('Bun fmt covers former source and document formats and preserves generated and wire bytes', () => {
  for (const [file, source] of Object.entries({ ...fixtures, ...preserved })) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
  }
  const run = (mode: string[]) =>
    Bun.spawnSync([process.execPath, 'fmt', ...mode], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 15000,
    });
  const before = run(['--check']);
  expect(before.exitCode, before.stderr.toString()).toBe(1);
  for (const file of Object.keys(fixtures)) expect(before.stdout.toString()).toContain(file);
  const fixed = run([]);
  expect(fixed.exitCode, fixed.stderr.toString()).toBe(0);
  for (const [file, source] of Object.entries(fixtures)) {
    expect(readFileSync(join(root, file), 'utf8'), `${file} must be formatted`).not.toBe(source);
  }
  for (const [file, source] of Object.entries(preserved)) {
    expect(readFileSync(join(root, file), 'utf8'), `${file} must retain exact bytes`).toBe(source);
  }
  const checked = run(['--check']);
  expect(checked.exitCode, checked.stderr.toString()).toBe(0);
}, 15000);

test('native staged formatting restages its changes and leaves unstaged files alone', () => {
  const source = 'export const staged={answer:42};\n';
  const untouched = 'export const unstaged={answer:42};\n';
  writeFileSync(join(root, 'source.ts'), source);
  writeFileSync(join(root, 'source.tsx'), untouched);
  for (const command of [
    ['git', 'init', '-q'],
    ['git', 'add', 'source.ts'],
    [process.execPath, 'fmt', '--staged'],
  ]) {
    const result = Bun.spawnSync(command, {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 15000,
    });
    expect(result.exitCode, `${command.join(' ')}: ${result.stderr}`).toBe(0);
  }
  const formatted = readFileSync(join(root, 'source.ts'), 'utf8');
  expect(formatted).not.toBe(source);
  expect(readFileSync(join(root, 'source.tsx'), 'utf8')).toBe(untouched);
  const staged = Bun.spawnSync(['git', 'show', ':source.ts'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(staged.exitCode, staged.stderr.toString()).toBe(0);
  expect(staged.stdout.toString()).toBe(formatted);
});
