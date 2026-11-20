import { describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { assertTemporaryHome, type TemporaryHomeHost } from '../lib/temp-home';
import {
  describeTempLeak,
  isForeignTempEntry,
  KEEP_BUILD_VERSION_FLAG,
  launcherHost,
  listTempLeftovers,
  parseLauncherArgs,
  REAL_HOME_ENV,
  runWithTestHome,
  shellExitCode,
  TEST_HOME_KIND,
  TEST_HOME_PREFIX,
  TEST_TMP_PREFIX,
  testChildEnv,
  type TestHomeChild,
  type TestHomeDependencies,
  testHomeEnv,
  testTempEnv,
} from '../lib/test-home';

const host: TemporaryHomeHost = { tmpDir: '/tmp', realHome: '/home/dev' };

/** A child status supplied by a host, with the launcher's actual temporary home retained. */
class FakeSignaledChild implements TestHomeChild, TestHomeDependencies {
  readonly exited = Promise.resolve(1);
  readonly spawn = (command: readonly string[], env: NodeJS.ProcessEnv) => {
    this.command = [...command];
    this.home = env.HOME ?? '';
    return this;
  };
  command: readonly string[] = [];
  home = '';
  signals: number[] = [];
  constructor(readonly signalCode: string | number) {}
  kill(signal: number): void {
    this.signals.push(signal);
  }
}

/** Records the environment a launched lane would start with, and exits cleanly. */
class FakeEnvRecordingChild implements TestHomeChild, TestHomeDependencies {
  readonly exited = Promise.resolve(0);
  readonly signalCode = null;
  readonly spawn = (_command: readonly string[], env: NodeJS.ProcessEnv) => {
    this.env = env;
    return this;
  };
  env: NodeJS.ProcessEnv = {};
  kill(): void {}
}

/** A launch failure after receiving the real temporary home to clean up. */
class FakeSpawnFailure implements TestHomeDependencies {
  home = '';
  readonly spawn = (_command: readonly string[], env: NodeJS.ProcessEnv): never => {
    this.home = env.HOME ?? '';
    throw new Error('fixture spawn failed');
  };
}

/** Prints what a child sees as its home, as one JSON line. */
const PROBE = [
  'import { homedir } from "node:os";',
  'console.log(JSON.stringify({',
  '  homedir: homedir(),',
  '  home: process.env.HOME,',
  '  userProfile: process.env.USERPROFILE,',
  '  realHome: process.env.MANGOSTUDIO_REAL_HOME,',
  '  gitGlobal: process.env.GIT_CONFIG_GLOBAL,',
  '  cargoHome: process.env.CARGO_HOME,',
  '  rustupHome: process.env.RUSTUP_HOME,',
  '  bunInstall: process.env.BUN_INSTALL,',
  '  bunCache: process.env.BUN_INSTALL_CACHE_DIR,',
  '  runtime: process.env.MANGOSTUDIO_RUNTIME_BINARY,',
  '}));',
].join('\n');

interface Probe {
  homedir: string;
  home: string;
  userProfile: string;
  realHome: string;
  gitGlobal: string;
  cargoHome: string;
  rustupHome: string;
  bunInstall: string;
  bunCache: string;
  runtime: string;
}

describe('launcherHost', () => {
  test('uses this process home when no outer launcher recorded one', () => {
    expect(launcherHost({}, host).realHome).toBe('/home/dev');
  });

  test('keeps the home an outer launcher recorded, so nesting never promotes a temp home to "real"', () => {
    const nested = launcherHost({ [REAL_HOME_ENV]: '/home/original' }, host);

    expect(
      nested.realHome,
      `expected realHome: /home/original | received: ${nested.realHome}`
    ).toBe('/home/original');
  });
});

describe('testHomeEnv', () => {
  const root = '/tmp/mangostudio-test-home-abc';

  test('moves HOME and USERPROFILE and records the original home', () => {
    const env = testHomeEnv(root, {}, host);

    expect(env.HOME).toBe(root);
    expect(env.USERPROFILE).toBe(root);
    expect(env[REAL_HOME_ENV]).toBe('/home/dev');
  });

  test('names an empty global git config inside the temporary home', () => {
    expect(testHomeEnv(root, {}, host).GIT_CONFIG_GLOBAL).toBe(join(root, '.gitconfig'));
  });

  test('pins the toolchain homes to the real ones', () => {
    const env = testHomeEnv(root, {}, host);

    expect(env.CARGO_HOME).toBe(join(host.realHome, '.cargo'));
    expect(env.RUSTUP_HOME).toBe(join(host.realHome, '.rustup'));
    expect(env.BUN_INSTALL).toBe(join(host.realHome, '.bun'));
    expect(env.BUN_INSTALL_CACHE_DIR).toBe(join(host.realHome, '.bun', 'install', 'cache'));
  });

  test('keeps a toolchain location the developer already exported', () => {
    const env = testHomeEnv(
      root,
      {
        CARGO_HOME: '/opt/cargo',
        RUSTUP_HOME: '/opt/rustup',
        BUN_INSTALL: '/opt/bun',
        BUN_INSTALL_CACHE_DIR: '/var/cache/bun',
      },
      host
    );

    expect(env.CARGO_HOME).toBe('/opt/cargo');
    expect(env.RUSTUP_HOME).toBe('/opt/rustup');
    expect(env.BUN_INSTALL).toBe('/opt/bun');
    expect(env.BUN_INSTALL_CACHE_DIR).toBe('/var/cache/bun');
  });

  test('derives the Bun cache from an exported BUN_INSTALL', () => {
    expect(testHomeEnv(root, { BUN_INSTALL: '/opt/bun' }, host).BUN_INSTALL_CACHE_DIR).toBe(
      join('/opt/bun', 'install', 'cache')
    );
  });
});

describe('testChildEnv', () => {
  test('drops an exported VERSION and keeps the rest of the ambient environment', () => {
    const env = testChildEnv(
      '/tmp/mangostudio-test-home-a1b2c3',
      { VERSION: '0.1.1-canary.50b10e9', PATH: '/usr/bin', MANGOSTUDIO_RUNTIME_BINARY: '/opt/rt' },
      host
    );

    expect(
      env.VERSION,
      `expected VERSION: undefined | received: ${String(env.VERSION)} (a release stamp reached the lane)`
    ).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.MANGOSTUDIO_RUNTIME_BINARY).toBe('/opt/rt');
    expect(env.HOME).toBe('/tmp/mangostudio-test-home-a1b2c3');
  });

  test('is a no-op for VERSION when none was exported', () => {
    const env = testChildEnv('/tmp/mangostudio-test-home-a1b2c3', { PATH: '/usr/bin' }, host);

    expect('VERSION' in env).toBe(false);
  });

  test('keeps the exported VERSION when the release job asks for it', () => {
    const env = testChildEnv(
      '/tmp/mangostudio-test-home-a1b2c3',
      { VERSION: '0.1.1-canary.50b10e9', PATH: '/usr/bin' },
      host,
      { keepBuildVersion: true }
    );

    expect(env.VERSION).toBe('0.1.1-canary.50b10e9');
    expect(env.HOME).toBe('/tmp/mangostudio-test-home-a1b2c3');
  });

  test('keepBuildVersion adds no VERSION key when none was exported', () => {
    const env = testChildEnv('/tmp/mangostudio-test-home-a1b2c3', { PATH: '/usr/bin' }, host, {
      keepBuildVersion: true,
    });

    expect('VERSION' in env).toBe(false);
  });
});

describe('parseLauncherArgs', () => {
  test('takes the keep flag only before the command', () => {
    expect(parseLauncherArgs([KEEP_BUILD_VERSION_FLAG, 'bash', 'run.sh'])).toEqual({
      options: { keepBuildVersion: true },
      command: ['bash', 'run.sh'],
    });
  });

  test('leaves the flag alone when it is the command’s own argument', () => {
    expect(parseLauncherArgs(['bash', 'run.sh', KEEP_BUILD_VERSION_FLAG])).toEqual({
      options: { keepBuildVersion: false },
      command: ['bash', 'run.sh', KEEP_BUILD_VERSION_FLAG],
    });
  });

  test('returns an empty command when only the flag was given', () => {
    expect(parseLauncherArgs([KEEP_BUILD_VERSION_FLAG]).command).toEqual([]);
  });
});

describe('shellExitCode', () => {
  test('reports the child exit code', () => {
    expect(shellExitCode(3, null)).toBe(3);
  });

  test('reports 128 plus the signal for a signalled child', () => {
    expect(shellExitCode(null, 15)).toBe(143);
  });

  test('keeps the signal number of a signal the launcher does not forward', () => {
    expect(shellExitCode(null, 6)).toBe(134);
    expect(shellExitCode(null, 9)).toBe(137);
  });

  test('reports failure when neither is known', () => {
    expect(shellExitCode(null, null)).toBe(1);
  });
});

describe('the test home shape check', () => {
  test('accepts a direct child of the temp directory with the test prefix', () => {
    expect(() =>
      assertTemporaryHome(join(host.tmpDir, `${TEST_HOME_PREFIX}abc`), TEST_HOME_KIND, host)
    ).not.toThrow();
  });

  test('accepts temporary homes under the real home while protecting home, ancestors and .mango', () => {
    const realHome = resolve(realpathSync(tmpdir()), 'mango-test-home-policy');
    const tmpDir = join(realHome, 'AppData', 'Local', 'Temp');
    const nestedHost = { realHome, tmpDir };
    expect(() =>
      assertTemporaryHome(join(tmpDir, `${TEST_HOME_PREFIX}abc`), TEST_HOME_KIND, nestedHost)
    ).not.toThrow();
    for (const candidate of [realHome, dirname(realHome)]) {
      expect(() => assertTemporaryHome(candidate, TEST_HOME_KIND, nestedHost)).toThrow(
        'it is, or contains, the real home'
      );
    }
    const mango = join(realHome, '.mango');
    for (const candidate of [mango, join(mango, `${TEST_HOME_PREFIX}abc`)]) {
      expect(() =>
        assertTemporaryHome(candidate, TEST_HOME_KIND, { realHome, tmpDir: mango })
      ).toThrow('it is inside ~/.mango');
    }
  });

  test('refuses the real home, naming the value and the expected shape', () => {
    expect(() => assertTemporaryHome(host.realHome, TEST_HOME_KIND, host)).toThrow(
      `api-tests: refusing test home. expected: ${join(host.tmpDir, `${TEST_HOME_PREFIX}<random>`)} | received: "/home/dev"`
    );
  });

  test('refuses a smoke-home-named directory, which belongs to another lane', () => {
    expect(() =>
      assertTemporaryHome(join(host.tmpDir, 'mangostudio-smoke-abc'), TEST_HOME_KIND, host)
    ).toThrow(`its name does not start with ${TEST_HOME_PREFIX}`);
  });
});

describe('runWithTestHome', () => {
  const bunProbe = ['bun', '-e', PROBE];

  /** Runs the probe through the launcher and returns what the child saw. */
  async function probe(ambient: NodeJS.ProcessEnv = process.env): Promise<Probe> {
    const reader = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, '..', 'with-test-home.ts'), ...bunProbe],
      env: { ...ambient } as Record<string, string>,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([
      new Response(reader.stdout).text(),
      new Response(reader.stderr).text(),
      reader.exited,
    ]);
    expect(code, `expected launcher exit: 0 | received: ${code} | stderr: ${err}`).toBe(0);
    return JSON.parse(out.trim().split('\n').at(-1) as string) as Probe;
  }

  test('starts the child with a fresh temporary home that is gone afterwards', async () => {
    const seen = await probe();
    const tempRoot = dirname(seen.home);
    const expectedShape = join(
      realpathSync(tmpdir()),
      `${TEST_TMP_PREFIX}<random>`,
      `${TEST_HOME_PREFIX}<random>`
    );

    // The home is a direct child of the lane's own temp directory, which is
    // itself a direct child of the launcher's.
    expect(
      basename(tempRoot).startsWith(TEST_TMP_PREFIX) &&
        basename(seen.home).startsWith(TEST_HOME_PREFIX) &&
        realpathSync(dirname(tempRoot)) === realpathSync(tmpdir()),
      `expected child HOME: ${expectedShape} | received: ${seen.home}`
    ).toBe(true);
    expect(
      existsSync(tempRoot),
      `expected the lane temp directory removed | still exists: ${tempRoot}`
    ).toBe(false);
    expect(seen.homedir, `expected homedir() to follow HOME | received: ${seen.homedir}`).toBe(
      seen.home
    );
    expect(seen.userProfile).toBe(seen.home);
    expect(
      existsSync(seen.home),
      `expected the test home removed | still exists: ${seen.home}`
    ).toBe(false);
  });

  test('records the original home for the preload and never hands the child the real one', async () => {
    const seen = await probe();
    const original = process.env[REAL_HOME_ENV] ?? homedir();

    expect(seen.realHome).toBe(original);
    expect(seen.home).not.toBe(original);
  });

  test('keeps a nested launcher from recording a temporary home as the real one', async () => {
    const outer = mkdtempSync(join(tmpdir(), TEST_HOME_PREFIX));
    try {
      const seen = await probe({ ...process.env, HOME: outer, [REAL_HOME_ENV]: '/home/original' });

      expect(seen.realHome).toBe('/home/original');
      expect(seen.home).not.toBe(outer);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  test('starts the child without the VERSION the shell exported', async () => {
    const child = new FakeEnvRecordingChild();

    await runWithTestHome(
      ['bun', 'fixture.ts'],
      { ...process.env, VERSION: '0.1.1-canary.50b10e9' },
      child
    );

    expect(
      child.env.VERSION,
      `expected the launched lane to have no VERSION | received: ${String(child.env.VERSION)}`
    ).toBeUndefined();
  });

  test('starts the child with the exported VERSION under keepBuildVersion', async () => {
    const child = new FakeEnvRecordingChild();

    await runWithTestHome(
      ['bun', 'fixture.ts'],
      { ...process.env, VERSION: '0.1.1-canary.50b10e9' },
      child,
      { keepBuildVersion: true }
    );

    expect(
      child.env.VERSION,
      `expected the launched release lane to keep VERSION 0.1.1-canary.50b10e9 | received: ${String(child.env.VERSION)}`
    ).toBe('0.1.1-canary.50b10e9');
  });

  test('passes the runtime binary and the pinned toolchain homes through', async () => {
    const seen = await probe({
      ...process.env,
      MANGOSTUDIO_RUNTIME_BINARY: '/opt/runtime/mangostudio-runtime',
    });
    const original = process.env[REAL_HOME_ENV] ?? homedir();

    expect(seen.runtime).toBe('/opt/runtime/mangostudio-runtime');
    expect(seen.cargoHome).toBe(process.env.CARGO_HOME?.trim() || join(original, '.cargo'));
    expect(seen.rustupHome).toBe(process.env.RUSTUP_HOME?.trim() || join(original, '.rustup'));
    expect(seen.bunInstall).toBe(process.env.BUN_INSTALL?.trim() || join(original, '.bun'));
    expect(seen.gitGlobal).toBe(join(seen.home, '.gitconfig'));
  });

  test("returns the child's exit code and still removes the home", async () => {
    const marker = mkdtempSync(join(tmpdir(), 'with-test-home-marker-'));
    try {
      const code = await runWithTestHome(
        [
          'bun',
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(join(marker, 'home'))}, process.env.HOME); process.exit(7)`,
        ],
        process.env
      );
      const home = await Bun.file(join(marker, 'home')).text();

      expect(code, `expected exit code: 7 | received: ${code}`).toBe(7);
      expect(existsSync(home), `expected the test home removed | still exists: ${home}`).toBe(
        false
      );
    } finally {
      rmSync(marker, { recursive: true, force: true });
    }
  });

  test('reports 128 plus the signal when the child is killed', async () => {
    const child = new FakeSignaledChild('SIGTERM');
    const code = await runWithTestHome(
      ['bun', '-e', "process.kill(process.pid, 'SIGTERM'); setTimeout(() => {}, 5000)"],
      process.env,
      process.platform === 'win32' ? child : undefined
    );

    expect(code, `expected exit code: 143 | received: ${code}`).toBe(143);
  });

  // SIGKILL cannot be intercepted, so unlike SIGABRT or SIGSEGV (which Bun's
  // crash handler can stall on a CI runner) it ends the child at once.
  test('reports 128 plus SIGKILL, not the forwarded-signal code, for an unforwarded signal', async () => {
    const child = new FakeSignaledChild('SIGKILL');
    const code = await runWithTestHome(
      ['bun', '-e', "process.kill(process.pid, 'SIGKILL'); setTimeout(() => {}, 5000)"],
      process.env,
      process.platform === 'win32' ? child : undefined
    );

    expect(code, `expected exit code: 137 (128 + SIGKILL) | received: ${code}`).toBe(137);
  });

  test.each([
    ['SIGTERM', 143],
    ['SIGKILL', 137],
    [15, 143],
    [34, 162],
    // Linux real-time signals stop at 64; 1..64 passes through unchanged.
    [1, 129],
    [64, 192],
    // Anything else is as unknown as an unrecognised name. 128 would give 256,
    // which `process.exit` wraps to 0 and reports as a pass.
    [65, 1],
    [128, 1],
    [-9, 1],
    [1.5, 1],
    [Number.NaN, 1],
    ['unknown-signal', 1],
  ] as const)(
    'maps injected %s status and removes its real temporary home',
    async (signal, expected) => {
      const child = new FakeSignaledChild(signal);
      const code = await runWithTestHome(['bun', 'fixture.ts'], process.env, child);
      expect(code, `expected exit code: ${expected} | received: ${code}`).toBe(expected);
      expect(child.command).toEqual([process.execPath, 'fixture.ts']);
      expect(child.home).toContain(TEST_HOME_PREFIX);
      expect(existsSync(child.home)).toBe(false);
    }
  );

  test('refuses an empty command, naming what it received', async () => {
    await expect(runWithTestHome([], process.env)).rejects.toThrow(
      'expected a command to run | received: none'
    );
  });

  test('removes the temporary home when the child cannot start', async () => {
    const dependency = new FakeSpawnFailure();
    await expect(runWithTestHome(['bun', 'fixture.ts'], process.env, dependency)).rejects.toThrow(
      'fixture spawn failed'
    );
    expect(dependency.home).toContain(TEST_HOME_PREFIX);
    try {
      expect(existsSync(dependency.home)).toBe(false);
    } finally {
      rmSync(dependency.home, { recursive: true, force: true });
    }
  });

  test('refuses an ordinary temp directory as a test home and keeps its contents', () => {
    const decoy = mkdtempSync(join(tmpdir(), 'not-a-test-home-'));
    mkdirSync(join(decoy, '.mango'));
    try {
      expect(() => assertTemporaryHome(decoy, TEST_HOME_KIND)).toThrow('refusing test home');
      expect(existsSync(join(decoy, '.mango'))).toBe(true);
    } finally {
      rmSync(decoy, { recursive: true, force: true });
    }
  });
});

/** A lane that creates the named entries in the temp directory it was given, then exits. */
class FakeTempWritingChild implements TestHomeChild, TestHomeDependencies {
  readonly exited: Promise<number>;
  readonly signalCode = null;
  readonly spawn = (_command: readonly string[], env: NodeJS.ProcessEnv) => {
    this.env = env;
    for (const name of this.entries) mkdirSync(join(env.TMPDIR ?? '', name));
    return this;
  };
  env: NodeJS.ProcessEnv = {};
  constructor(
    private readonly entries: readonly string[],
    exitCode = 0
  ) {
    this.exited = Promise.resolve(exitCode);
  }
  kill(): void {}
}

describe('the test temp directory', () => {
  /** Runs the lane and returns its code and everything it wrote to stderr. */
  async function launch(child: FakeTempWritingChild): Promise<{ code: number; stderr: string }> {
    const written: string[] = [];
    const write = spyOn(process.stderr, 'write').mockImplementation(
      (chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      }
    );
    try {
      const code = await runWithTestHome(['bun', 'fixture.ts'], process.env, child);
      return { code, stderr: written.join('') };
    } finally {
      write.mockRestore();
    }
  }

  test('points TMPDIR, TMP and TEMP at one directory that holds the home, not the reverse', async () => {
    const child = new FakeTempWritingChild([]);

    await launch(child);

    const { TMPDIR, TMP, TEMP, HOME } = child.env;
    expect([TMP, TEMP]).toEqual([TMPDIR, TMPDIR]);
    expect(basename(TMPDIR ?? '').startsWith(TEST_TMP_PREFIX)).toBe(true);
    // The lane's shape check wants the home to be a direct child of its temp directory.
    expect(dirname(HOME ?? '')).toBe(TMPDIR ?? '');
  });

  test('removes the directory after the run, leftovers included', async () => {
    const child = new FakeTempWritingChild(['left-over-abc123']);

    await launch(child);

    expect(existsSync(child.env.TMPDIR ?? '')).toBe(false);
  });

  test('passes a lane that left nothing behind', async () => {
    const { code, stderr } = await launch(new FakeTempWritingChild([]));

    expect(`code ${code} stderr ${JSON.stringify(stderr)}`).toBe('code 0 stderr ""');
  });

  test('fails a green lane that left entries behind, naming each one', async () => {
    const { code, stderr } = await launch(
      new FakeTempWritingChild(['skills-doctor-aaa111', 'skill-diag-bbb222'])
    );

    expect(code, `expected exit code: 1 (a leak) | received: ${code}`).toBe(1);
    expect(stderr).toContain('tests left 2 entries in their temp directory');
    expect(stderr).toContain('received: skill-diag-bbb222, skills-doctor-aaa111');
  });

  test('keeps the exit code of a lane that already failed, and still lists the leftovers', async () => {
    const { code, stderr } = await launch(new FakeTempWritingChild(['leaked-ccc333'], 7));

    expect(code, `expected exit code: 7 (the lane's own) | received: ${code}`).toBe(7);
    expect(stderr).toContain('received: leaked-ccc333');
  });

  test('describeTempLeak counts the entries it does not list', () => {
    const names = Array.from(
      { length: 25 },
      (_, index) => `entry-${String(index).padStart(2, '0')}`
    );

    const message = describeTempLeak('/tmp/t', names);

    expect(message).toContain('tests left 25 entries');
    expect(message).toContain('entry-19, … (5 more)');
    expect(message).not.toContain('entry-20');
  });

  test('describeTempLeak uses the singular for one entry', () => {
    expect(describeTempLeak('/tmp/t', ['only-one'])).toContain('tests left 1 entry in');
  });

  test('listTempLeftovers lists nothing for an empty directory and sorted names otherwise', () => {
    const root = mkdtempSync(join(tmpdir(), 'with-test-home-leftovers-'));
    try {
      expect(listTempLeftovers(root)).toEqual([]);
      mkdirSync(join(root, 'b'));
      mkdirSync(join(root, 'a'));
      expect(listTempLeftovers(root)).toEqual(['a', 'b']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe('PowerShell policy-probe files', () => {
    const probeNames = [
      '__PSScriptPolicyTest_a1b2c3d4.e5f.ps1',
      '__PSScriptPolicyTest_a1b2c3d4.e5f.psm1',
      '__psscriptpolicytest_A1B2C3D4.E5F.PS1',
    ];

    test('are ignored on Windows, case-insensitively', () => {
      const root = mkdtempSync(join(tmpdir(), 'with-test-home-probe-'));
      try {
        for (const name of probeNames) writeFileSync(join(root, name), '');
        expect(listTempLeftovers(root, 'win32')).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test('never hide another leftover, including near-miss names', () => {
      const lookalikes = [
        'leaked-ccc333',
        '__PSScriptPolicyTest_.ps1',
        '__PSScriptPolicyTest_a1b2.ps1.txt',
        'x__PSScriptPolicyTest_a1b2.c3d.ps1',
        '__PSScriptPolicyTest_a1b2.c3d.ps2',
      ];
      const root = mkdtempSync(join(tmpdir(), 'with-test-home-probe-'));
      try {
        for (const name of [...probeNames, ...lookalikes]) writeFileSync(join(root, name), '');
        expect(listTempLeftovers(root, 'win32')).toEqual([...lookalikes].sort());
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test('still count as leaks off Windows', () => {
      expect(isForeignTempEntry(probeNames[0] ?? '', 'linux')).toBe(false);
    });
  });

  test('testTempEnv sets every variable a process reads for its temp directory', () => {
    expect(testTempEnv('/tmp/x')).toEqual({ TMPDIR: '/tmp/x', TMP: '/tmp/x', TEMP: '/tmp/x' });
  });
});
