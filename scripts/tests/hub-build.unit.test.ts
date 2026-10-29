import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  discardHubBuildRecord,
  type HubBuildRecord,
  parseHubBuildRecord,
  readHubBuildRecords,
  validateNativeHubSet,
  writeHubBuildRecord,
} from '../lib/hub-build';
import { ALL_BINARY_TARGETS, runtimeBinaryName } from '../lib/release-targets';
import { renderStandaloneReadme } from '../lib/standalone-readme';
import { fakeElf, fakeMachO } from './support/executable-fixtures';

const record: HubBuildRecord = {
  schemaVersion: 1,
  target: 'linux-x64',
  compilerMode: 'native',
  compilerVersion: '1.4.4',
  compilerRevision: 'a'.repeat(40),
  compilerSha256: 'b'.repeat(64),
  sourceSha: 'c'.repeat(40),
  gitDirty: false,
  version: '1.0.0',
  buildType: 'production',
  builtAt: '2026-10-29T00:00:00.000Z',
  hubSha256: 'd'.repeat(64),
  hubSize: 100,
  runtimeSha256: 'e'.repeat(64),
  runtimeSize: 100,
};

describe('parseHubBuildRecord', () => {
  test('preserves explicit native and bytecode provenance', () => {
    expect(parseHubBuildRecord(record)).toEqual(record);
    expect(parseHubBuildRecord({ ...record, compilerMode: 'bytecode' }).compilerMode).toBe(
      'bytecode'
    );
  });

  test.each([
    ['schemaVersion', 0, 'hub build schemaVersion: 1'],
    ['target', 'linux-riscv64', 'hub build target: release platform'],
    ['compilerMode', undefined, 'hub build compilerMode: native | bytecode'],
    ['compilerMode', 'jit', 'binary compiler: native | bytecode'],
    ['compilerRevision', 'short', 'hub build compilerRevision: full Bun revision'],
    ['compilerSha256', 'short', 'hub build compilerSha256: SHA256'],
    ['hubSha256', 'short', 'hub build hubSha256: SHA256'],
    ['runtimeSha256', 'short', 'hub build runtimeSha256: SHA256'],
    ['sourceSha', 'short', 'hub build sourceSha: full Git SHA or unknown'],
    ['gitDirty', 'false', 'hub build gitDirty: boolean or unknown'],
    ['compilerVersion', '', 'hub build compilerVersion: nonempty string'],
    ['version', '', 'hub build version: nonempty string'],
    ['buildType', '', 'hub build buildType: nonempty string'],
    ['builtAt', '1', 'hub build builtAt: ISO date string'],
    ['hubSize', 0, 'hub build hubSize: positive integer'],
    ['runtimeSize', -1, 'hub build runtimeSize: positive integer'],
    ['hubSize', 1.5, 'hub build hubSize: positive integer'],
  ])('rejects invalid %s=%j', (field, value, shape) => {
    expect(() => parseHubBuildRecord({ ...record, [field as string]: value })).toThrow(
      `expected ${shape} | received: ${String(value)}`
    );
  });

  test.each([null, [], 'record'].map((value) => [value] as const))(
    'rejects non-object %j',
    (value) => {
      expect(() => parseHubBuildRecord(value)).toThrow('expected hub build record object');
    }
  );
});

describe('validateNativeHubSet', () => {
  const records = ALL_BINARY_TARGETS.map((target) => ({ ...record, target: target.arch }));
  const expected = { sourceSha: record.sourceSha, version: record.version };

  test('accepts all shipping targets with independent canary revisions', () => {
    expect(() =>
      validateNativeHubSet(
        records.map((row, index) => ({ ...row, compilerRevision: String(index).repeat(40) })),
        expected
      )
    ).not.toThrow();
  });

  test('refuses missing and duplicate targets', () => {
    expect(() => validateNativeHubSet(records.slice(1), expected)).toThrow(
      'expected 8 distinct native hub targets'
    );
    expect(() => validateNativeHubSet([...records.slice(1), records[1]], expected)).toThrow(
      'expected 8 distinct native hub targets'
    );
  });

  test.each([
    ['compilerMode', 'bytecode'],
    ['buildType', 'development'],
    ['gitDirty', true],
    ['sourceSha', 'f'.repeat(40)],
    ['version', '2.0.0'],
    ['builtAt', '2026-10-29T00:00:01.000Z'],
  ] as const)('refuses a mismatched %s', (field, value) => {
    const invalid = records.map((row, index) => (index === 1 ? { ...row, [field]: value } : row));
    expect(() => validateNativeHubSet(invalid, expected)).toThrow(
      `expected ${records[1].target} ${field}:`
    );
  });
});

test('hub records bind actual bytes, reject changed binaries and discard stale completion evidence', () => {
  const target = ALL_BINARY_TARGETS.find((candidate) => candidate.arch === 'linux-x64');
  if (!target) throw new Error('expected linux-x64 release target');
  const root = mkdtempSync(join(tmpdir(), 'hub-build-record-'));
  const directory = join(root, '.mango/out', target.arch);
  mkdirSync(directory, { recursive: true });
  const bytes = fakeElf({
    arch: 'x64',
    interpreter: '/lib64/ld-linux-x86-64.so.2',
    strings: ['GLIBC_2.17'],
  });
  writeFileSync(join(directory, target.name), bytes);
  writeFileSync(join(directory, runtimeBinaryName(target.name)), bytes);
  try {
    const written = writeHubBuildRecord(root, { ...record, target: target.arch });
    expect(written.hubSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(readHubBuildRecords(root)).toEqual([written]);
    writeFileSync(join(directory, target.name), fakeMachO('x64'));
    expect(() => writeHubBuildRecord(root, { ...record, target: target.arch })).toThrow(
      'expected elf x64 | received: macho x64'
    );
    writeFileSync(join(directory, target.name), 'wrong executable bytes');
    expect(() => readHubBuildRecords(root)).toThrow(`expected ${target.arch}/${target.name}:`);
    discardHubBuildRecord(root, target.arch);
    expect(existsSync(join(root, '.mango/hub-builds', `${target.arch}.json`))).toBe(false);
    expect(() => discardHubBuildRecord(root, target.arch)).not.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('common distribution README lists all verified targets and build identity', () => {
  const text = renderStandaloneReadme(record, ALL_BINARY_TARGETS, record.builtAt);
  for (const target of ALL_BINARY_TARGETS) expect(text).toContain(`\`${target.arch}\``);
  expect(text).toContain('Version 1.0.0');
  expect(text).toContain(`Build time: ${record.builtAt}`);
  expect(text).toContain('Build type: production');
});
