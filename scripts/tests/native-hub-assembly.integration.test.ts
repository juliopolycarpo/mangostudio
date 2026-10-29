import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { HubBuildRecord } from '../lib/hub-build';
import { assembleNativeHubs } from '../lib/native-hub-assembly';
import { ALL_BINARY_TARGETS, type BinaryTarget, runtimeBinaryName } from '../lib/release-targets';
import { fakeElf, fakeMachO, fakePe } from './support/executable-fixtures';

let root: string;
const identity = { sourceSha: 'a'.repeat(40), version: '1.0.0' };

function fakeTargetExecutable(target: BinaryTarget, runtime: boolean): Uint8Array {
  const arch = target.arch.includes('arm64') ? 'arm64' : 'x64';
  if (target.arch.startsWith('darwin-')) return fakeMachO(arch);
  if (target.arch.startsWith('windows-')) return fakePe(arch);
  const musl = target.arch.endsWith('-musl');
  const loader = musl
    ? arch === 'x64'
      ? '/lib/ld-musl-x86_64.so.1'
      : '/lib/ld-musl-aarch64.so.1'
    : arch === 'x64'
      ? '/lib64/ld-linux-x86-64.so.2'
      : '/lib/ld-linux-aarch64.so.1';
  return fakeElf({
    arch,
    interpreter: musl && runtime ? null : loader,
    strings: musl ? [] : ['GLIBC_2.17'],
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'native-hub-assembly-'));
  const recordDir = join(root, '.mango/hub-builds');
  mkdirSync(recordDir, { recursive: true });
  for (const [index, target] of ALL_BINARY_TARGETS.entries()) {
    const directory = join(root, '.mango/out', target.arch);
    mkdirSync(directory, { recursive: true });
    const hub = fakeTargetExecutable(target, false);
    const runtime = fakeTargetExecutable(target, true);
    writeFileSync(join(directory, target.name), hub, { mode: 0o644 });
    writeFileSync(join(directory, runtimeBinaryName(target.name)), runtime, { mode: 0o644 });
    const record: HubBuildRecord = {
      schemaVersion: 1,
      target: target.arch,
      compilerMode: 'native',
      compilerVersion: '1.4.4',
      compilerRevision: String(index).repeat(40),
      compilerSha256: 'b'.repeat(64),
      ...identity,
      gitDirty: false,
      buildType: 'production',
      builtAt: '2026-10-29T00:00:00.000Z',
      hubSha256: createHash('sha256').update(hub).digest('hex'),
      hubSize: hub.length,
      runtimeSha256: createHash('sha256').update(runtime).digest('hex'),
      runtimeSize: runtime.length,
    };
    writeFileSync(join(recordDir, `${target.arch}.json`), JSON.stringify(record));
  }
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('assembleNativeHubs', () => {
  test('restores Unix executable modes after raw artifact transport and writes one complete README', () => {
    const records = assembleNativeHubs(root, identity);
    expect(records).toHaveLength(8);
    expect(new Set(records.map((record) => record.compilerRevision)).size).toBe(8);
    const readme = readFileSync(join(root, '.mango/out/README.md'), 'utf8');
    for (const target of ALL_BINARY_TARGETS) {
      expect(readme).toContain(target.arch);
      if (process.platform === 'win32') continue;
      const mode = target.arch.startsWith('windows-') ? 0o644 : 0o755;
      expect(statSync(join(root, '.mango/out', target.arch, target.name)).mode & 0o777).toBe(mode);
      expect(
        statSync(join(root, '.mango/out', target.arch, runtimeBinaryName(target.name))).mode & 0o777
      ).toBe(mode);
    }
  });

  test('removes a stale completion marker and refuses corrupt transported bytes before chmod', () => {
    const readme = join(root, '.mango/out/README.md');
    writeFileSync(readme, 'old successful build');
    writeFileSync(join(root, '.mango/out/linux-x64/mangostudio'), 'wrong transported executable');
    expect(() => assembleNativeHubs(root, identity)).toThrow('expected linux-x64/mangostudio:');
    expect(existsSync(readme)).toBe(false);
    if (process.platform !== 'win32') {
      expect(statSync(join(root, '.mango/out/linux-arm64/mangostudio')).mode & 0o777).toBe(0o644);
    }
  });

  test('refuses an incomplete native set before publishing completion', () => {
    const readme = join(root, '.mango/out/README.md');
    writeFileSync(readme, 'old successful build');
    rmSync(join(root, '.mango/hub-builds/darwin-arm64.json'));
    expect(() => assembleNativeHubs(root, identity)).toThrow(
      'expected 8 distinct native hub targets'
    );
    expect(existsSync(readme)).toBe(false);
  });
});
