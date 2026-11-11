import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type HubBuildRecord, readHubBuildRecords } from '../lib/hub-build';
import { assembleNativeHubs } from '../lib/native-hub-assembly';
import { ALL_BINARY_TARGETS, type BinaryTarget, runtimeBinaryName } from '../lib/release-targets';
import { type RuntimeArtifactIdentity, writeRuntimeArtifactReceipt } from '../lib/runtime-artifact';
import { prebuiltRuntimePath } from '../lib/runtime-build';
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

function stageSplitInputs(profile: RuntimeArtifactIdentity['profile']) {
  const runtimeDir = join(root, '.mango/runtime-prebuilt');
  const versionReceiptsDir = join(root, '.mango/runtime-versions');
  const compileDir = join(root, '.mango/hub-compiles');
  mkdirSync(compileDir, { recursive: true });
  mkdirSync(versionReceiptsDir, { recursive: true });
  for (const target of ALL_BINARY_TARGETS) {
    const paired = join(root, '.mango/hub-builds', `${target.arch}.json`);
    const { runtimeSha256, runtimeSize, ...compile } = JSON.parse(
      readFileSync(paired, 'utf8')
    ) as HubBuildRecord;
    rmSync(paired);
    writeFileSync(join(compileDir, `${target.arch}.json`), JSON.stringify(compile));
    const staged = join(runtimeDir, target.arch);
    mkdirSync(staged, { recursive: true });
    renameSync(
      join(root, '.mango/out', target.arch, runtimeBinaryName(target.name)),
      prebuiltRuntimePath(runtimeDir, target)
    );
    const cross = target.arch === 'windows-arm64';
    writeRuntimeArtifactReceipt(
      runtimeDir,
      target,
      { ...identity, profile },
      cross ? null : identity.version
    );
    if (cross) {
      writeFileSync(
        join(versionReceiptsDir, `${target.arch}.json`),
        JSON.stringify({
          schemaVersion: 1,
          target: target.arch,
          ...identity,
          profile,
          sha256: runtimeSha256,
          size: runtimeSize,
          reportedVersion: identity.version,
        })
      );
    }
  }
  return { runtimeDir, versionReceiptsDir, profile };
}

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

  test.each(['shipping', 'light'] as const)(
    'pairs all compiler and runtime inputs with the expected %s profile',
    (profile) => {
      const inputs = stageSplitInputs(profile);
      const records = assembleNativeHubs(root, identity, inputs);
      expect(records).toHaveLength(ALL_BINARY_TARGETS.length);
      expect(readHubBuildRecords(root)).toEqual(records);
      expect(new Set(records.map(({ compilerRevision }) => compilerRevision)).size).toBe(8);
      expect(readFileSync(join(root, '.mango/out/README.md'), 'utf8')).toContain(identity.version);
    }
  );

  test('refuses missing native version evidence before staging any runtime', () => {
    const inputs = stageSplitInputs('shipping');
    rmSync(join(inputs.versionReceiptsDir, 'windows-arm64.json'));
    const readme = join(root, '.mango/out/README.md');
    writeFileSync(readme, 'old successful build');
    expect(() => assembleNativeHubs(root, identity, inputs)).toThrow(
      'expected windows-arm64 runtime version receipt'
    );
    expect(existsSync(readme)).toBe(false);
    expect(readHubBuildRecords(root)).toEqual([]);
    expect(existsSync(join(root, '.mango/out/linux-x64/mangostudio-runtime'))).toBe(false);
  });

  test('rejects a native version receipt for a different binary', () => {
    const inputs = stageSplitInputs('shipping');
    const path = join(inputs.versionReceiptsDir, 'windows-arm64.json');
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...receipt, sha256: 'c'.repeat(64) }));
    expect(() => assembleNativeHubs(root, identity, inputs)).toThrow(
      'expected windows-arm64 runtime:'
    );
    expect(readHubBuildRecords(root)).toEqual([]);
  });

  test('rejects a cross runtime with a receipt that reports no executed version', () => {
    const inputs = stageSplitInputs('shipping');
    const path = join(inputs.versionReceiptsDir, 'windows-arm64.json');
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...receipt, reportedVersion: null }));
    expect(() => assembleNativeHubs(root, identity, inputs)).toThrow(
      'expected windows-arm64 runtime reportedVersion: 1.0.0 | received: null'
    );
  });
});
