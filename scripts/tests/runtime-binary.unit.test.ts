import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildProfileOf, newestWorkspaceBuild } from '../bench/runtime-binary';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'runtime-binary-test-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Writes `target/<profile>/mangostudio-runtime` with the given age in seconds. */
function build(profile: string, ageSeconds: number): string {
  const directory = join(root, 'target', profile);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'mangostudio-runtime');
  writeFileSync(path, '');
  const time = new Date(Date.now() - ageSeconds * 1000);
  utimesSync(path, time, time);
  return path;
}

describe('newestWorkspaceBuild', () => {
  test('returns undefined when no profile directory holds a runtime', async () => {
    expect(await newestWorkspaceBuild(root, '')).toBeUndefined();
  });

  test('picks the most recently modified build across release, release-fast and debug', async () => {
    build('release', 300);
    const fast = build('release-fast', 100);
    build('debug', 200);
    expect(await newestWorkspaceBuild(root, '')).toBe(fast);
  });

  test('a later debug build wins over an older release build', async () => {
    build('release', 300);
    const debug = build('debug', 10);
    expect(await newestWorkspaceBuild(root, '')).toBe(debug);
  });

  test('appends the executable suffix it is given', async () => {
    const directory = join(root, 'target', 'release');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'mangostudio-runtime.exe'), '');
    expect(await newestWorkspaceBuild(root, '.exe')).toBe(
      join(directory, 'mangostudio-runtime.exe')
    );
    expect(await newestWorkspaceBuild(root, '')).toBeUndefined();
  });
});

describe('buildProfileOf', () => {
  test.each([
    ['/repo/target/release/mangostudio-runtime', 'release'],
    ['/repo/target/release-fast/mangostudio-runtime', 'release-fast'],
    ['/repo/target/debug/mangostudio-runtime', 'debug'],
    ['C:\\repo\\target\\release-fast\\mangostudio-runtime.exe', 'release-fast'],
    ['/tmp/ci-artifact/mangostudio-runtime', 'unknown'],
  ])('labels %s as %s', (binary, expected) => {
    expect(buildProfileOf(binary), `expected profile for ${binary}`).toBe(expected);
  });
});
