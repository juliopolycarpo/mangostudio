import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertTemporaryHome, type TemporaryHomeHost } from '../lib/temp-home';
import {
  launcherHost,
  REAL_HOME_ENV,
  runWithTestHome,
  shellExitCode,
  TEST_HOME_KIND,
  TEST_HOME_PREFIX,
  testHomeEnv,
} from '../lib/test-home';

const host: TemporaryHomeHost = { tmpDir: '/tmp', realHome: '/home/dev' };

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

    expect(env.CARGO_HOME).toBe('/home/dev/.cargo');
    expect(env.RUSTUP_HOME).toBe('/home/dev/.rustup');
    expect(env.BUN_INSTALL).toBe('/home/dev/.bun');
    expect(env.BUN_INSTALL_CACHE_DIR).toBe(join('/home/dev/.bun', 'install', 'cache'));
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
    const expectedShape = join(realpathSync(tmpdir()), `${TEST_HOME_PREFIX}<random>`);

    expect(
      realpathSync(join(seen.home, '..')) === realpathSync(tmpdir()) &&
        seen.home.includes(TEST_HOME_PREFIX),
      `expected child HOME: ${expectedShape} | received: ${seen.home}`
    ).toBe(true);
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
    const code = await runWithTestHome(
      ['bun', '-e', "process.kill(process.pid, 'SIGTERM'); setTimeout(() => {}, 5000)"],
      process.env
    );

    expect(code, `expected exit code: 143 | received: ${code}`).toBe(143);
  });

  // SIGKILL cannot be intercepted, so unlike SIGABRT or SIGSEGV (which Bun's
  // crash handler can stall on a CI runner) it ends the child at once.
  test('reports 128 plus SIGKILL, not the forwarded-signal code, for an unforwarded signal', async () => {
    const code = await runWithTestHome(
      ['bun', '-e', "process.kill(process.pid, 'SIGKILL'); setTimeout(() => {}, 5000)"],
      process.env
    );

    expect(code, `expected exit code: 137 (128 + SIGKILL) | received: ${code}`).toBe(137);
  });

  test('refuses an empty command, naming what it received', async () => {
    await expect(runWithTestHome([], process.env)).rejects.toThrow(
      'expected a command to run | received: none'
    );
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
