import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { ALL_BINARY_TARGETS } from '../lib/release-targets';
import { readRuntimeArtifactReceipt, writeRuntimeArtifactReceipt } from '../lib/runtime-artifact';
import { prebuiltRuntimePath } from '../lib/runtime-build';
import { fakeElf, fakeMachO } from './support/executable-fixtures';

const target = ALL_BINARY_TARGETS.find((candidate) => candidate.arch === 'linux-x64');
if (!target) throw new Error('expected linux-x64 release target');
const identity = { sourceSha: 'a'.repeat(40), version: '1.0.0', profile: 'shipping' } as const;
const runtime = fakeElf({
  arch: 'x64',
  interpreter: '/lib64/ld-linux-x86-64.so.2',
  strings: ['GLIBC_2.17'],
});
let root: string;
let binary: string;
let receiptFile: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'runtime-artifact-'));
  binary = prebuiltRuntimePath(root, target);
  mkdirSync(dirname(binary), { recursive: true });
  writeFileSync(binary, runtime);
  receiptFile = join(dirname(binary), 'runtime-build.json');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('runtime artifact receipts', () => {
  test.each(['1.0.0\n', null])(
    'binds source, version, profile, and verified bytes (%j)',
    (observed) => {
      writeRuntimeArtifactReceipt(root, target, identity, observed);
      expect(readRuntimeArtifactReceipt(root, target, identity)).toEqual({
        ...identity,
        schemaVersion: 1,
        target: target.arch,
        sha256: createHash('sha256').update(runtime).digest('hex'),
        size: runtime.byteLength,
        reportedVersion: observed?.trim() ?? null,
      });
    }
  );

  test('refuses to record an unidentified source or mismatched version', () => {
    expect(() =>
      writeRuntimeArtifactReceipt(root, target, { ...identity, sourceSha: 'local' }, null)
    ).toThrow('expected runtime sourceSha: full Git SHA | received: local');
    expect(() => writeRuntimeArtifactReceipt(root, target, identity, '2.0.0')).toThrow(
      'expected --version: 1.0.0 | received: 2.0.0'
    );
  });

  test.each([
    ['schemaVersion', 2, '1'],
    ['target', 'darwin-x64', 'linux-x64'],
    ['sourceSha', 'b'.repeat(40), identity.sourceSha],
    ['version', '2.0.0', identity.version],
    ['profile', 'light', identity.profile],
    ['reportedVersion', '2.0.0', '1.0.0 or null'],
  ])('refuses a transported receipt with %s=%s', (field, value, expected) => {
    writeRuntimeArtifactReceipt(root, target, identity, '1.0.0');
    const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
    writeFileSync(receiptFile, JSON.stringify({ ...receipt, [field]: value }));
    expect(() => readRuntimeArtifactReceipt(root, target, identity)).toThrow(
      `expected linux-x64 runtime ${field}: ${expected} | received: ${value}`
    );
  });

  test('refuses a substituted runtime, including one with a matching receipt for another format', () => {
    writeRuntimeArtifactReceipt(root, target, identity, '1.0.0');
    writeFileSync(binary, fakeMachO('x64'));
    expect(() => readRuntimeArtifactReceipt(root, target, identity)).toThrow(
      'expected linux-x64 runtime:'
    );
    writeRuntimeArtifactReceipt(root, target, identity, '1.0.0');
    expect(() => readRuntimeArtifactReceipt(root, target, identity)).toThrow(
      'expected elf x64 | received: macho x64'
    );
  });
});
