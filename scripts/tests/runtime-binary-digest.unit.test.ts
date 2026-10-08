/**
 * Guard for the cached API unit lane: Turbo must not replay a pass that was
 * recorded against a different `mangostudio-runtime`.
 *
 * Turbo hashes the *path* `MANGOSTUDIO_RUNTIME_BINARY` names (through the
 * `MANGOSTUDIO_*` allowlist on `test:unit`), never the file behind it, and the
 * default `target/debug` build is not in the key at all. A rebuilt or replaced
 * binary therefore replayed the earlier pass. `scripts/test.ts` exports the
 * SHA-256 of the binary the tests spawn, so these tests pin the digest (content,
 * not path or mtime), the resolution it follows, and the Turbo key that carries it.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getRuntimeBinaryOverride } from '../../apps/api/src/lib/config';
import {
  newestRuntimeBuild,
  workspaceRuntimeBinaryCandidates,
} from '../../apps/api/src/lib/runtime-paths';
import { ROOT_DIR } from '../lib/config';
import {
  RUNTIME_BINARY_DIGEST_ENV,
  resolveLaneRuntimeBinary,
  runtimeBinaryDigestEnv,
  sha256OfFile,
} from '../lib/runtime-binary-digest';
import { readText } from './support/read-text';

const BINARY_NAME =
  process.platform === 'win32' ? 'mangostudio-runtime.exe' : 'mangostudio-runtime';
const HEX_SHA256 = /^[0-9a-f]{64}$/;

/** SHA-256 of the three bytes "abc", the FIPS 180-2 test vector. */
const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

/** Same length on purpose: only the bytes differ, not the size. */
const REAL_RUNTIME_BYTES = 'runtime-build-A: speaks stdio';
const FAKE_RUNTIME_BYTES = 'runtime-build-B: bans stdio!!';

const EPOCH_S = 1_700_000_000;

const scratchDirs: string[] = [];

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratchRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mango-runtime-digest-'));
  scratchDirs.push(dir);
  return dir;
}

/**
 * A named fake runtime binary: `bytes` at `path`, last modified `mtimeS` seconds
 * after the epoch, so a test can hold the mtime fixed while the bytes change.
 *
 * @example
 * await fakeRuntimeBinary(join(dir, 'runtime'), REAL_RUNTIME_BYTES, EPOCH_S);
 */
async function fakeRuntimeBinary(path: string, bytes: string, mtimeS: number): Promise<string> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, bytes, { mode: 0o755 });
  await utimes(path, mtimeS, mtimeS);
  return path;
}

/** `<targetDir>/<profile>/mangostudio-runtime`, where cargo leaves a build. */
function cargoBuildPath(targetDir: string, profile: 'debug' | 'release'): string {
  return join(targetDir, profile, BINARY_NAME);
}

/** The digest the lane exports, failing with the whole environment when there is none. */
async function exportedDigest(
  env: Record<string, string>,
  rootDir: string,
  label: string
): Promise<string> {
  const exported = await runtimeBinaryDigestEnv(env, rootDir);
  const digest = exported[RUNTIME_BINARY_DIGEST_ENV];
  expect(
    digest ?? '',
    `expected ${RUNTIME_BINARY_DIGEST_ENV} to carry a 64-hex SHA-256 for ${label} | received: ${JSON.stringify(exported)}`
  ).toMatch(HEX_SHA256);
  return digest as string;
}

/**
 * Replacing a binary has to move the exported digest. Both values are in the
 * message, `undefined` included, so a lane that exports nothing says so.
 */
function expectDigestToChange(before: string | undefined, after: string | undefined, path: string) {
  expect(
    after !== undefined && after !== before,
    `expected ${RUNTIME_BINARY_DIGEST_ENV} to differ after the bytes at ${path} were replaced | received: ${before} before and ${after} after`
  ).toBe(true);
}

/** The digest the lane exports for `env`, or undefined when it exports none. */
async function digestOrUndefined(
  env: Record<string, string>,
  rootDir: string
): Promise<string | undefined> {
  return (await runtimeBinaryDigestEnv(env, rootDir))[RUNTIME_BINARY_DIGEST_ENV];
}

describe('runtimeBinaryDigestEnv: a binary named by MANGOSTUDIO_RUNTIME_BINARY', () => {
  test('exports a different digest when the bytes at the same path change', async () => {
    const root = await scratchRoot();
    const binary = join(root, 'runtime-under-test');
    const env = { MANGOSTUDIO_RUNTIME_BINARY: binary };

    await fakeRuntimeBinary(binary, REAL_RUNTIME_BYTES, EPOCH_S);
    const before = await digestOrUndefined(env, root);
    // Same path, same size, same mtime: only the content moved.
    await fakeRuntimeBinary(binary, FAKE_RUNTIME_BYTES, EPOCH_S);
    const after = await digestOrUndefined(env, root);

    expectDigestToChange(before, after, binary);
  });

  test('exports one digest for the same bytes at another path and mtime', async () => {
    const root = await scratchRoot();
    const first = await fakeRuntimeBinary(
      join(root, 'one', 'runtime'),
      REAL_RUNTIME_BYTES,
      EPOCH_S
    );
    const second = await fakeRuntimeBinary(
      join(root, 'two', 'renamed-runtime'),
      REAL_RUNTIME_BYTES,
      EPOCH_S + 86_400
    );

    const firstDigest = await exportedDigest({ MANGOSTUDIO_RUNTIME_BINARY: first }, root, first);
    const secondDigest = await exportedDigest({ MANGOSTUDIO_RUNTIME_BINARY: second }, root, second);

    expect(
      secondDigest,
      `expected ${RUNTIME_BINARY_DIGEST_ENV} to depend on content only | received: ${firstDigest} for ${first} and ${secondDigest} for ${second}, which hold identical bytes`
    ).toBe(firstDigest);
  });

  test('exports the SHA-256 of the file, not of its path or a mix of both', async () => {
    const root = await scratchRoot();
    const binary = await fakeRuntimeBinary(join(root, 'runtime'), 'abc', EPOCH_S);

    const digest = await exportedDigest({ MANGOSTUDIO_RUNTIME_BINARY: binary }, root, binary);

    expect(digest, `expected SHA-256 of "abc" | received: ${digest}`).toBe(ABC_SHA256);
  });

  test('prefers the override over a build at the default target path', async () => {
    const root = await scratchRoot();
    await fakeRuntimeBinary(
      cargoBuildPath(join(root, 'target'), 'debug'),
      FAKE_RUNTIME_BYTES,
      EPOCH_S
    );
    const binary = await fakeRuntimeBinary(join(root, 'named'), 'abc', EPOCH_S);

    const digest = await exportedDigest({ MANGOSTUDIO_RUNTIME_BINARY: binary }, root, binary);

    expect(digest, `expected the digest of ${binary} | received: ${digest}`).toBe(ABC_SHA256);
  });

  test('resolves a relative override from apps/api, where the tests run', async () => {
    const root = await scratchRoot();
    await fakeRuntimeBinary(join(root, 'apps', 'api', 'bin', 'runtime'), 'abc', EPOCH_S);

    const digest = await exportedDigest(
      { MANGOSTUDIO_RUNTIME_BINARY: 'bin/runtime' },
      root,
      'a relative override'
    );

    expect(
      digest,
      `expected the digest of ${root}/apps/api/bin/runtime | received: ${digest}`
    ).toBe(ABC_SHA256);
  });

  test('treats a blank override as unset', async () => {
    const root = await scratchRoot();
    await fakeRuntimeBinary(cargoBuildPath(join(root, 'target'), 'debug'), 'abc', EPOCH_S);

    const digest = await exportedDigest(
      { MANGOSTUDIO_RUNTIME_BINARY: '   ' },
      root,
      'a blank override'
    );

    expect(digest, `expected the default build's digest | received: ${digest}`).toBe(ABC_SHA256);
  });
});

describe('runtimeBinaryDigestEnv: a binary at the default target path', () => {
  test('exports a different digest when the build at target/debug is replaced', async () => {
    const root = await scratchRoot();
    const targetDir = join(root, 'target');
    const binary = cargoBuildPath(targetDir, 'debug');

    await fakeRuntimeBinary(binary, REAL_RUNTIME_BYTES, EPOCH_S);
    const before = await digestOrUndefined({}, root);
    await fakeRuntimeBinary(binary, FAKE_RUNTIME_BYTES, EPOCH_S);
    const after = await digestOrUndefined({}, root);

    expectDigestToChange(before, after, binary);
  });

  test('follows CARGO_TARGET_DIR, absolute or relative to the repository root', async () => {
    const root = await scratchRoot();
    const absolute = join(root, 'elsewhere');
    await fakeRuntimeBinary(cargoBuildPath(absolute, 'debug'), 'abc', EPOCH_S);
    await fakeRuntimeBinary(
      cargoBuildPath(join(root, 'out'), 'debug'),
      FAKE_RUNTIME_BYTES,
      EPOCH_S
    );

    const fromAbsolute = await exportedDigest({ CARGO_TARGET_DIR: absolute }, root, absolute);
    const fromRelative = await exportedDigest({ CARGO_TARGET_DIR: 'out' }, root, 'out');

    expect(fromAbsolute, `expected the build under ${absolute} | received: ${fromAbsolute}`).toBe(
      ABC_SHA256
    );
    expect(
      fromRelative,
      `expected a relative CARGO_TARGET_DIR to resolve from ${root} | received: ${fromRelative}, the digest of the build under ${absolute}`
    ).not.toBe(ABC_SHA256);
  });

  test('digests the newest of target/debug and target/release, debug on a tie', async () => {
    const root = await scratchRoot();
    const targetDir = join(root, 'target');
    const debug = cargoBuildPath(targetDir, 'debug');
    const release = cargoBuildPath(targetDir, 'release');
    const digestOfDebug = async () => {
      await fakeRuntimeBinary(debug, 'abc', EPOCH_S);
      return await sha256OfFile(debug);
    };

    const debugDigest = await digestOfDebug();
    await fakeRuntimeBinary(release, FAKE_RUNTIME_BYTES, EPOCH_S + 60);
    const releaseNewer = await exportedDigest({}, root, 'a newer release build');
    await fakeRuntimeBinary(release, FAKE_RUNTIME_BYTES, EPOCH_S - 60);
    const debugNewer = await exportedDigest({}, root, 'a newer debug build');
    await fakeRuntimeBinary(release, FAKE_RUNTIME_BYTES, EPOCH_S);
    const tie = await exportedDigest({}, root, 'equal mtimes');

    expect(
      releaseNewer,
      `expected the newer release build to win | received: ${releaseNewer}`
    ).toBe(await sha256OfFile(release));
    expect(debugNewer, `expected the newer debug build to win | received: ${debugNewer}`).toBe(
      debugDigest
    );
    expect(tie, `expected debug to win a tie, as the hub's resolver does | received: ${tie}`).toBe(
      debugDigest
    );
  });
});

describe('runtimeBinaryDigestEnv: no binary', () => {
  test('exports nothing when there is no build, so the lane keeps its own error', async () => {
    const root = await scratchRoot();

    const exported = await runtimeBinaryDigestEnv({}, root);

    expect(
      exported,
      `expected no ${RUNTIME_BINARY_DIGEST_ENV} without a runtime binary | received: ${JSON.stringify(exported)}`
    ).toEqual({});
  });

  test('exports nothing when the override names a file that does not exist', async () => {
    const root = await scratchRoot();
    const missing = join(root, 'never-built');
    await fakeRuntimeBinary(cargoBuildPath(join(root, 'target'), 'debug'), 'abc', EPOCH_S);

    const exported = await runtimeBinaryDigestEnv({ MANGOSTUDIO_RUNTIME_BINARY: missing }, root);

    // The tests raise "MANGOSTUDIO_RUNTIME_BINARY is set to <path>, which does
    // not exist"; digesting the default build would hide that behind a pass.
    expect(
      exported,
      `expected no ${RUNTIME_BINARY_DIGEST_ENV} for a missing override ${missing} | received: ${JSON.stringify(exported)}`
    ).toEqual({});
  });

  test('exports nothing when the override names a directory', async () => {
    const root = await scratchRoot();

    const exported = await runtimeBinaryDigestEnv({ MANGOSTUDIO_RUNTIME_BINARY: root }, root);

    expect(
      exported,
      `expected no ${RUNTIME_BINARY_DIGEST_ENV} for a directory ${root} | received: ${JSON.stringify(exported)}`
    ).toEqual({});
  });
});

// A regular file the lane cannot read is not "no binary": the tests may still run
// it, so exporting nothing would key the cache on the path alone again.
describe('runtimeBinaryDigestEnv: a binary the lane cannot read', () => {
  const canDenyReads = process.platform !== 'win32' && process.getuid?.() !== 0;

  test.skipIf(!canDenyReads)('rejects naming the path instead of exporting nothing', async () => {
    const root = await scratchRoot();
    const binary = await fakeRuntimeBinary(join(root, 'execute-only'), 'abc', EPOCH_S);
    await chmod(binary, 0o111);

    const failure = await runtimeBinaryDigestEnv({ MANGOSTUDIO_RUNTIME_BINARY: binary }, root).then(
      (exported) => `resolved ${JSON.stringify(exported)}`,
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    );

    expect(
      failure,
      `expected a rejection naming ${binary} and "a readable file" | received: ${failure}`
    ).toContain(`Cannot digest runtime binary '${binary}'; expected a readable file`);
  });
});

describe('sha256OfFile', () => {
  test('digests a file larger than one read chunk', async () => {
    const root = await scratchRoot();
    const path = join(root, 'large');
    const bytes = new Uint8Array(5 * 1024 * 1024 + 3).fill(0x61);
    await writeFile(path, bytes);

    const digest = await sha256OfFile(path);

    const expected = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
    expect(
      digest,
      `expected the SHA-256 of ${bytes.length} bytes of "a" | received: ${digest}`
    ).toBe(expected);
  });

  test('names the path and the expected shape when the file cannot be read', async () => {
    const root = await scratchRoot();
    const missing = join(root, 'missing-runtime');

    const failure = await sha256OfFile(missing).then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    );

    expect(
      failure,
      `expected a rejection naming ${missing} and "a readable file" | received: ${failure}`
    ).toContain(missing);
    expect(failure).toContain('a readable file');
  });
});

describe('resolveLaneRuntimeBinary matches the resolver the tests and the hub use', () => {
  interface Scenario {
    readonly name: string;
    readonly env: (root: string) => Record<string, string>;
    readonly builds: readonly { readonly profile: 'debug' | 'release'; readonly mtimeS: number }[];
    readonly targetDir: string;
  }

  const SCENARIOS: readonly Scenario[] = [
    { name: 'no build', env: () => ({}), builds: [], targetDir: 'target' },
    {
      name: 'debug only',
      env: () => ({}),
      builds: [{ profile: 'debug', mtimeS: EPOCH_S }],
      targetDir: 'target',
    },
    {
      name: 'release only',
      env: () => ({}),
      builds: [{ profile: 'release', mtimeS: EPOCH_S }],
      targetDir: 'target',
    },
    {
      name: 'release newer than debug',
      env: () => ({}),
      builds: [
        { profile: 'debug', mtimeS: EPOCH_S },
        { profile: 'release', mtimeS: EPOCH_S + 60 },
      ],
      targetDir: 'target',
    },
    {
      name: 'debug newer than release',
      env: () => ({}),
      builds: [
        { profile: 'debug', mtimeS: EPOCH_S + 60 },
        { profile: 'release', mtimeS: EPOCH_S },
      ],
      targetDir: 'target',
    },
    {
      name: 'equal mtimes',
      env: () => ({}),
      builds: [
        { profile: 'debug', mtimeS: EPOCH_S },
        { profile: 'release', mtimeS: EPOCH_S },
      ],
      targetDir: 'target',
    },
    {
      name: 'relative CARGO_TARGET_DIR',
      env: () => ({ CARGO_TARGET_DIR: 'moved' }),
      builds: [{ profile: 'release', mtimeS: EPOCH_S }],
      targetDir: 'moved',
    },
    {
      name: 'absolute CARGO_TARGET_DIR',
      env: (root) => ({ CARGO_TARGET_DIR: join(root, 'absolute-target') }),
      builds: [{ profile: 'debug', mtimeS: EPOCH_S }],
      targetDir: 'absolute-target',
    },
  ];

  for (const scenario of SCENARIOS) {
    test(scenario.name, async () => {
      const root = await scratchRoot();
      for (const build of scenario.builds) {
        await fakeRuntimeBinary(
          cargoBuildPath(join(root, scenario.targetDir), build.profile),
          `${build.profile} build`,
          build.mtimeS
        );
      }
      const env = scenario.env(root);

      const hub = newestRuntimeBuild(workspaceRuntimeBinaryCandidates(root, env));
      const lane = resolveLaneRuntimeBinary(env, root);

      expect(
        lane,
        `expected the lane to digest the binary the hub resolves for ${scenario.name} | received: ${lane}, the hub resolves ${hub}`
      ).toBe(hub);
    });
  }

  test('an override', async () => {
    const root = await scratchRoot();
    const binary = await fakeRuntimeBinary(join(root, 'named-runtime'), 'abc', EPOCH_S);
    const env = { MANGOSTUDIO_RUNTIME_BINARY: `  ${binary}  ` };

    const lane = resolveLaneRuntimeBinary(env, root);

    expect(
      lane,
      `expected the lane to digest the override the hub reads | received: ${lane}, the hub reads ${getRuntimeBinaryOverride(env)}`
    ).toBe(getRuntimeBinaryOverride(env) ?? null);
  });
});

describe('Turbo cache key of the API unit lane', () => {
  /** The `@mangostudio/api#test:unit` task hash Turbo computes for `env`, without running it. */
  async function unitTaskHash(digest: string | null): Promise<string> {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env[RUNTIME_BINARY_DIGEST_ENV];
    if (digest !== null) env[RUNTIME_BINARY_DIGEST_ENV] = digest;
    const probe = Bun.spawn({
      cmd: [
        join(ROOT_DIR, 'node_modules', '.bin', 'turbo'),
        'run',
        'test:unit',
        '--filter=@mangostudio/api',
        '--dry=json',
      ],
      cwd: ROOT_DIR,
      env: env as Record<string, string>,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
      probe.exited,
    ]);
    expect(code, `expected turbo dry run exit: 0 | received: ${code} | stderr: ${err.trim()}`).toBe(
      0
    );
    const { tasks } = JSON.parse(out) as { tasks: { taskId: string; hash: string }[] };
    const task = tasks.find((candidate) => candidate.taskId === '@mangostudio/api#test:unit');
    expect(task, 'expected a @mangostudio/api#test:unit task in the Turbo dry run').toBeDefined();
    return (task as { hash: string }).hash;
  }

  test('hashes the exported digest, so a replaced binary is a cache miss', async () => {
    const real = 'a'.repeat(64);
    const fake = 'b'.repeat(64);

    const [withReal, withFake, withoutDigest, withRealAgain] = await Promise.all([
      unitTaskHash(real),
      unitTaskHash(fake),
      unitTaskHash(null),
      unitTaskHash(real),
    ]);

    expect(
      withFake,
      `expected the @mangostudio/api test:unit hash to change with ${RUNTIME_BINARY_DIGEST_ENV} | expected: "MANGOSTUDIO_*" kept in the env of test:unit in turbo.jsonc | received: hash ${withReal} for ${real.slice(0, 8)}… and the same hash for ${fake.slice(0, 8)}…`
    ).not.toBe(withReal);
    expect(
      withoutDigest,
      `expected a lane with no runtime binary to hash differently from one with a digest | received: ${withoutDigest} for both`
    ).not.toBe(withReal);
    expect(
      withRealAgain,
      `expected an unchanged binary to keep its hash, so the cache still hits | received: ${withRealAgain} after ${withReal}`
    ).toBe(withReal);
  });

  test('is fed by scripts/test.ts before Turbo starts', () => {
    const testScript = readText('scripts/test.ts');

    expect(
      testScript.includes('runtimeBinaryDigestEnv('),
      'expected scripts/test.ts to export the runtime binary digest to the Turbo unit phase | expected: a call to runtimeBinaryDigestEnv | received: no such call'
    ).toBe(true);
  });
});
