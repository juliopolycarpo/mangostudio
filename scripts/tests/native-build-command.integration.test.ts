import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { hostReleasePlatform } from '../lib/bun-cross-runtime';
import { readReleaseStamp, stampRuntimeFile } from '../lib/runtime-stamp';
import { FakeNativeBuildInputs } from './support/fake-native-build-inputs';

const platform = hostReleasePlatform();

// This fixture uses POSIX command wrappers and a Bun-backed fake runtime.
// Windows and static-musl runtimes need their real artifact smoke gates.
test.skipIf(!platform || platform.startsWith('windows') || platform.endsWith('-musl'))(
  'native packaging uses the running compiler and inherits root project settings',
  async () => {
    if (!platform) throw new Error('expected supported native fixture host');
    const fake = new FakeNativeBuildInputs(platform);
    try {
      await fake.prepare();
      const built = fake.run();
      expect(built.exitCode, `${built.stdout.toString()}\n${built.stderr.toString()}`).toBe(0);
      const hub = join(fake.root, '.mango/out', platform, 'mangostudio');
      const result = Bun.spawnSync([hub], { stdout: 'pipe', stderr: 'pipe', timeout: 5000 });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(result.stdout.toString().trim()).toBe('root-config');
      const receipt = JSON.parse(
        readFileSync(join(fake.root, '.mango/hub-builds', `${platform}.json`), 'utf8')
      );
      expect(receipt.compilerSha256).toBe(
        createHash('sha256').update(readFileSync(process.execPath)).digest('hex')
      );
      expect(receipt.hubSha256).toBe(createHash('sha256').update(readFileSync(hub)).digest('hex'));
    } finally {
      fake.dispose();
    }
  },
  60000
);

test.skipIf(!platform || platform.startsWith('windows') || platform.endsWith('-musl'))(
  'native hub-only build succeeds without Cargo runtime bytes or a pair completion marker',
  async () => {
    if (!platform) throw new Error('expected supported native fixture host');
    const fake = new FakeNativeBuildInputs(platform);
    try {
      await fake.prepare();
      rmSync(fake.runtime);
      const built = fake.run(['--hub-only']);
      expect(built.exitCode, `${built.stdout.toString()}\n${built.stderr.toString()}`).toBe(0);
      const out = join(fake.root, '.mango/out');
      const receipt = JSON.parse(
        readFileSync(join(fake.root, '.mango/hub-compiles', `${platform}.json`), 'utf8')
      );
      expect(receipt.hubSha256).toBe(
        createHash('sha256')
          .update(readFileSync(join(out, platform, 'mangostudio')))
          .digest('hex')
      );
      expect(receipt).not.toHaveProperty('runtimeSha256');
      expect(existsSync(join(out, platform, 'mangostudio-runtime'))).toBe(false);
      expect(existsSync(join(out, 'README.md'))).toBe(false);
      expect(existsSync(join(fake.root, '.mango/hub-builds', `${platform}.json`))).toBe(false);
      const conflicting = fake.run(['--hub-only', '--compiler', 'bytecode']);
      expect(conflicting.exitCode).toBe(1);
      expect(conflicting.stderr.toString()).toContain('received: compiler=bytecode');
    } finally {
      fake.dispose();
    }
  },
  60000
);

test.skipIf(!platform || platform.startsWith('windows') || platform.endsWith('-musl'))(
  'runtime artifact builds require a clean checkout at the recorded source',
  async () => {
    if (!platform) throw new Error('expected supported native fixture host');
    const fake = new FakeNativeBuildInputs(platform);
    try {
      await fake.prepare();
      const modifiedSource = ' M crates/mangostudio-runtime/src/main.rs';
      const artifactArgs = ['--artifact-profile', 'shipping'];
      const receipt = join(fake.root, '.mango/runtime', platform, 'runtime-build.json');
      for (const status of [modifiedSource, '?? crates/mangostudio-runtime/src/untracked.rs']) {
        const dirty = await fake.runRuntimeBuild(artifactArgs, status);
        expect(
          dirty.exitCode,
          `expected dirty artifact checkout to exit 1 | received: ${dirty.exitCode}\n${dirty.stdout.toString()}\n${dirty.stderr.toString()}`
        ).toBe(1);
        expect(dirty.stderr.toString()).toContain(
          `expected clean runtime checkout for SOURCE_SHA ${fake.sourceSha} | received: ${status}`
        );
        expect(existsSync(receipt)).toBe(false);
      }

      const local = await fake.runRuntimeBuild([], modifiedSource);
      expect(local.exitCode, local.stderr.toString()).toBe(0);
      expect(existsSync(receipt)).toBe(false);

      const clean = await fake.runRuntimeBuild(artifactArgs);
      expect(clean.exitCode, clean.stderr.toString()).toBe(0);
      expect(JSON.parse(readFileSync(receipt, 'utf8'))).toMatchObject({
        sourceSha: fake.sourceSha,
        profile: 'shipping',
        reportedVersion: fake.version,
      });
    } finally {
      fake.dispose();
    }
  },
  60000
);

/** A prebuilt runtime directory holding a copy of the fake runtime, as `--runtime-dir` expects. */
function prebuiltRuntimeDir(fake: FakeNativeBuildInputs, stampedWith?: string): string {
  const directory = join(fake.root, 'prebuilt');
  const copy = join(directory, fake.platform, 'mangostudio-runtime');
  mkdirSync(dirname(copy), { recursive: true });
  copyFileSync(fake.runtime, copy);
  if (stampedWith) stampRuntimeFile(copy, stampedWith);
  return directory;
}

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

test.skipIf(!platform || platform.startsWith('windows') || platform.endsWith('-musl'))(
  'an unstamped prebuilt runtime is stamped in the staged copy and its source is left alone',
  async () => {
    if (!platform) throw new Error('expected supported native fixture host');
    const fake = new FakeNativeBuildInputs(platform);
    try {
      await fake.prepare();
      const directory = prebuiltRuntimeDir(fake);
      const source = join(directory, platform, 'mangostudio-runtime');
      const sourceHash = sha256(source);

      const built = fake.run(['--runtime-dir', directory]);

      expect(built.exitCode, `${built.stdout.toString()}\n${built.stderr.toString()}`).toBe(0);
      const staged = join(fake.root, '.mango/out', platform, 'mangostudio-runtime');
      expect(readReleaseStamp(readFileSync(staged)).version).toBe(fake.version);
      expect(sha256(source), `expected the caller's runtime directory untouched`).toBe(sourceHash);
      expect(readReleaseStamp(readFileSync(source)).version).toBeNull();
    } finally {
      fake.dispose();
    }
  },
  60000
);

test.skipIf(!platform || platform.startsWith('windows') || platform.endsWith('-musl'))(
  'a prebuilt runtime already stamped with this version passes through, and another version is refused',
  async () => {
    if (!platform) throw new Error('expected supported native fixture host');
    const fake = new FakeNativeBuildInputs(platform);
    try {
      await fake.prepare();
      const same = fake.run(['--runtime-dir', prebuiltRuntimeDir(fake, fake.version)]);
      expect(same.exitCode, `${same.stdout.toString()}\n${same.stderr.toString()}`).toBe(0);

      rmSync(join(fake.root, 'prebuilt'), { recursive: true });
      const other = fake.run(['--runtime-dir', prebuiltRuntimeDir(fake, '9.9.9')]);
      expect(other.exitCode).toBe(1);
      expect(other.stderr.toString()).toContain(
        `expected an unstamped release slot or one already carrying ${fake.version} | received: 9.9.9`
      );
    } finally {
      fake.dispose();
    }
  },
  60000
);
