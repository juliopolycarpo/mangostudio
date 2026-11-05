import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createFrontendArtifact,
  type FrontendArtifactIdentity,
  frontendBuildEnvironment,
  verifyFrontendArtifact,
} from '../lib/frontend-artifact';

const identity: FrontendArtifactIdentity = {
  sourceSha: 'a'.repeat(40),
  bunRevision: 'b'.repeat(40),
  lockfileSha256: 'c'.repeat(64),
  environment: { MANGO_API_URL: '', VITE_API_URL: '' },
};
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'frontend-artifact-'));
  roots.push(root);
  mkdirSync(join(root, 'apps/frontend/dist/assets'), { recursive: true });
  writeFileSync(
    join(root, 'apps/frontend/dist/index.html'),
    '<script src="/assets/main-a.js"></script>'
  );
  writeFileSync(join(root, 'apps/frontend/dist/assets/main-a.js'), 'export {};');
  writeFileSync(
    join(root, 'apps/frontend/dist/build-info.json'),
    JSON.stringify({
      gitSha: identity.sourceSha.slice(0, 12),
      gitDirty: false,
      buildType: 'production',
      builtAt: '2026-11-04T00:00:00.000Z',
    })
  );
  writeFileSync(
    join(root, 'apps/frontend/dist-metafile.json'),
    JSON.stringify({ outputs: { '.dist-staging-1/assets/main-a.js': { bytes: 10 } } })
  );
  return root;
}

describe('production frontend artifact', () => {
  test('records and validates exact production bytes and the required metafile', () => {
    const root = fixture();
    const report = createFrontendArtifact(root, identity);
    expect(report.files).toHaveLength(4);
    expect(verifyFrontendArtifact(root, report, identity)).toEqual(report);
  });
  test('captures both accepted build URL environment inputs', () => {
    expect(frontendBuildEnvironment({})).toEqual({ MANGO_API_URL: '', VITE_API_URL: '' });
    expect(
      frontendBuildEnvironment({
        MANGO_API_URL: 'https://api.test',
        VITE_API_URL: 'https://old.test',
        OTHER: 'ignored',
      })
    ).toEqual({ MANGO_API_URL: 'https://api.test', VITE_API_URL: 'https://old.test' });
  });
  test.each(['sourceSha', 'bunRevision', 'lockfileSha256', 'environment'] as const)(
    'rejects mismatched %s',
    (field) => {
      const root = fixture();
      const report = createFrontendArtifact(root, identity);
      const changed = {
        ...identity,
        [field]:
          field === 'environment'
            ? { ...identity.environment, MANGO_API_URL: 'different' }
            : 'd'.repeat(field === 'lockfileSha256' ? 64 : 40),
      };
      expect(() => verifyFrontendArtifact(root, report, changed)).toThrow(
        `frontend ${field}: expected`
      );
    }
  );
  test.each(['extra', 'changed', 'missing'])(
    'rejects %s output instead of measuring or embedding it',
    (change) => {
      const root = fixture();
      const report = createFrontendArtifact(root, identity);
      if (change === 'missing') rmSync(join(root, 'apps/frontend/dist/index.html'));
      else
        writeFileSync(
          join(root, `apps/frontend/dist/${change === 'extra' ? 'assets/stale.js' : 'index.html'}`),
          'stale'
        );
      expect(() => verifyFrontendArtifact(root, report, identity)).toThrow(
        /expected (exact producer inventory|required output)/
      );
    }
  );
  test('refuses a missing metafile and one describing different output bytes', () => {
    const root = fixture();
    writeFileSync(
      join(root, 'apps/frontend/dist-metafile.json'),
      JSON.stringify({ outputs: { 'assets/main-a.js': { bytes: 99 } } })
    );
    expect(() => createFrontendArtifact(root, identity)).toThrow('expected 10 bytes');
    rmSync(join(root, 'apps/frontend/dist-metafile.json'));
    expect(() => createFrontendArtifact(root, identity)).toThrow('dist-metafile.json');
  });
  test.each([true, 'unknown'])('refuses dirty build-info %j', (gitDirty) => {
    const root = fixture();
    writeFileSync(
      join(root, 'apps/frontend/dist/build-info.json'),
      JSON.stringify({
        gitSha: identity.sourceSha.slice(0, 12),
        gitDirty,
        buildType: 'production',
        builtAt: '2026-11-04T00:00:00.000Z',
      })
    );
    expect(() => createFrontendArtifact(root, identity)).toThrow('expected clean production');
  });
  test('rejects symlinks in the transferable output', () => {
    const root = fixture();
    symlinkSync('main-a.js', join(root, 'apps/frontend/dist/assets/link.js'));
    expect(() => createFrontendArtifact(root, identity)).toThrow(
      'expected regular file or directory'
    );
  });
  test.each([null, {}, { schemaVersion: 2 }])('rejects malformed report %j', (value) => {
    expect(() => verifyFrontendArtifact(fixture(), value, identity)).toThrow('expected version 1');
  });
});

describe('explicit frontend producer identity', () => {
  test('accepts producer revision independently of the consumer Bun executable', () => {
    const root = fixture();
    expect(identity.bunRevision).not.toBe(Bun.revision);
    const artifact = createFrontendArtifact(root, identity);
    expect(verifyFrontendArtifact(root, artifact, identity).identity.bunRevision).toBe(
      identity.bunRevision
    );
  });
  test.each([[[]], [['--bun-revision', 'canary']]])(
    'CLI refuses missing or mutable revision %j',
    async (args) => {
      const result = Bun.spawn(['bun', './scripts/ci/frontend-artifact.ts', 'verify', ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stderr = await new Response(result.stderr).text();
      expect(await result.exited).toBe(1);
      expect(stderr).toContain('verify --bun-revision <40-character producer SHA>');
    }
  );
});
