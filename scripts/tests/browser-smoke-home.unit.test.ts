import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import {
  assertTemporarySmokeHome,
  describeSmokeHomeShape,
  prepareSmokeHome,
  removeSmokeHome,
  SMOKE_HOME_ENV,
  SMOKE_HOME_PREFIX,
  SMOKE_HUB_HOST,
  type SmokeHomeHost,
  smokeHubEnv,
} from '../../tests/browser-smoke/support/smoke-home';

/** A sandbox standing in for the machine: its own temp dir and "real" home. */
let sandbox: string;
let host: SmokeHomeHost;

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'smoke-home-test-')));
  const tmpDir = join(sandbox, 'tmp');
  const realHome = join(sandbox, 'home');
  mkdirSync(tmpDir);
  mkdirSync(join(realHome, '.mango'), { recursive: true });
  host = { tmpDir, realHome };
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('describeSmokeHomeShape', () => {
  test('names the temp directory and the smoke prefix', () => {
    expect(describeSmokeHomeShape(host)).toBe(join(host.tmpDir, `${SMOKE_HOME_PREFIX}<random>`));
  });
});

describe('assertTemporarySmokeHome', () => {
  test('accepts a smoke directory directly under the temp directory', () => {
    expect(() =>
      assertTemporarySmokeHome(join(host.tmpDir, `${SMOKE_HOME_PREFIX}abc`), host)
    ).not.toThrow();
  });

  const refused: Array<[string, (h: SmokeHomeHost) => string]> = [
    ['the real ~/.mango', (h) => join(h.realHome, '.mango')],
    ['the real home itself', (h) => h.realHome],
    ['a directory inside the real ~/.mango', (h) => join(h.realHome, '.mango', 'smoke')],
    ['the filesystem root', () => '/'],
    ['a relative path', () => `${SMOKE_HOME_PREFIX}abc`],
    ['an empty value', () => ''],
    ['a temp directory without the smoke prefix', (h) => join(h.tmpDir, 'other-abc')],
    [
      'a smoke directory nested deeper than the temp root',
      (h) => join(h.tmpDir, 'x', `${SMOKE_HOME_PREFIX}a`),
    ],
    ['the temp directory itself', (h) => h.tmpDir],
  ];

  for (const [label, pick] of refused) {
    test(`refuses ${label}, naming the path and the expected shape`, () => {
      const candidate = pick(host);
      expect(() => assertTemporarySmokeHome(candidate, host)).toThrow(
        `expected: ${describeSmokeHomeShape(host)} | received: ${JSON.stringify(candidate)}`
      );
    });
  }

  test('refuses a smoke-named directory when the temp directory is the real home', () => {
    const inHome: SmokeHomeHost = { tmpDir: host.realHome, realHome: host.realHome };
    expect(() => assertTemporarySmokeHome(join(inHome.realHome, '.mango'), inHome)).toThrow(
      'inside ~/.mango'
    );
  });
});

describe('assertTemporarySmokeHome path tricks', () => {
  function refusalOf(candidate: string, forHost: SmokeHomeHost = host): string {
    try {
      assertTemporarySmokeHome(candidate, forHost);
    } catch (error) {
      return String(error);
    }
    return '';
  }

  test('refuses ".." segments that climb out of the temp directory into the real home', () => {
    const candidate = join(host.tmpDir, `${SMOKE_HOME_PREFIX}a`, '..', '..', 'home', '.mango');
    expect(refusalOf(candidate)).toContain(`received: ${JSON.stringify(candidate)}`);
  });

  test('refuses a ".." that would resolve through a symlink to a directory outside the temp directory', () => {
    const outside = join(sandbox, 'elsewhere');
    mkdirSync(join(outside, 'sub'), { recursive: true });
    mkdirSync(join(outside, `${SMOKE_HOME_PREFIX}victim`));
    symlinkSync(join(outside, 'sub'), join(host.tmpDir, 'linkdir'));
    const candidate = `${join(host.tmpDir, 'linkdir')}/../${SMOKE_HOME_PREFIX}victim`;

    expect(refusalOf(candidate)).toContain('".." segments');
    expect(() => removeSmokeHome(candidate, host)).toThrow(
      `received: ${JSON.stringify(candidate)}`
    );
    expect(
      existsSync(join(outside, `${SMOKE_HOME_PREFIX}victim`)),
      `expected directory kept: ${join(outside, `${SMOKE_HOME_PREFIX}victim`)}`
    ).toBe(true);
  });

  test('refuses a smoke-named symlink that points into the real ~/.mango, and keeps its target', () => {
    const link = join(host.tmpDir, `${SMOKE_HOME_PREFIX}link`);
    const real = join(host.realHome, '.mango');
    writeFileSync(join(real, 'database.sqlite'), 'x');
    symlinkSync(real, link);

    expect(refusalOf(link)).toContain(`received: ${JSON.stringify(link)}`);
    expect(() => removeSmokeHome(link, host)).toThrow('refusing smoke hub home');
    expect(existsSync(join(real, 'database.sqlite'))).toBe(true);
  });

  test('refuses a smoke-named symlink that points at a directory outside the temp directory', () => {
    const target = join(sandbox, 'elsewhere');
    const link = join(host.tmpDir, `${SMOKE_HOME_PREFIX}other`);
    mkdirSync(target);
    symlinkSync(target, link);

    expect(refusalOf(link)).toContain('not a direct child of the OS temp directory');
    expect(() => removeSmokeHome(link, host)).toThrow('refusing smoke hub home');
    expect(existsSync(target)).toBe(true);
  });

  test('accepts a temp directory reached through a symlink, as macOS /tmp -> /private/tmp is', () => {
    const real = join(sandbox, 'private-tmp');
    mkdirSync(join(real, `${SMOKE_HOME_PREFIX}a`), { recursive: true });
    const linked: SmokeHomeHost = { tmpDir: join(sandbox, 'tmp-link'), realHome: host.realHome };
    symlinkSync(real, linked.tmpDir);

    expect(refusalOf(join(linked.tmpDir, `${SMOKE_HOME_PREFIX}a`), linked)).toBe('');
  });

  test('refuses a whitespace-only value', () => {
    expect(refusalOf('   ')).toContain('received: "   "');
  });
});

describe('prepareSmokeHome', () => {
  test('creates a smoke directory and publishes it for workers', () => {
    const env: NodeJS.ProcessEnv = {};
    const root = prepareSmokeHome(env, host);

    expect(existsSync(root), `expected directory to exist: ${root}`).toBe(true);
    expect(root.startsWith(join(host.tmpDir, SMOKE_HOME_PREFIX))).toBe(true);
    expect(env[SMOKE_HOME_ENV]).toBe(root);
    removeSmokeHome(root, host);
  });

  test('reuses the directory a runner already published', () => {
    const published = join(host.tmpDir, `${SMOKE_HOME_PREFIX}shared`);
    const env: NodeJS.ProcessEnv = { [SMOKE_HOME_ENV]: published };

    expect(prepareSmokeHome(env, host)).toBe(published);
    expect(existsSync(published)).toBe(true);
  });

  test('refuses a published value that is the real home itself', () => {
    const env: NodeJS.ProcessEnv = { [SMOKE_HOME_ENV]: host.realHome };

    expect(() => prepareSmokeHome(env, host)).toThrow(`received: ${JSON.stringify(host.realHome)}`);
  });

  test('refuses a published value inside the real home', () => {
    const inside = join(host.realHome, 'projects', `${SMOKE_HOME_PREFIX}x`);
    const env: NodeJS.ProcessEnv = { [SMOKE_HOME_ENV]: inside };

    expect(() => prepareSmokeHome(env, host)).toThrow(`received: ${JSON.stringify(inside)}`);
  });

  test('refuses a published value inside the real home even when the temp directory is the home', () => {
    const inHome: SmokeHomeHost = { tmpDir: host.realHome, realHome: host.realHome };
    const env: NodeJS.ProcessEnv = { [SMOKE_HOME_ENV]: join(host.realHome, '.mango') };

    expect(() => prepareSmokeHome(env, inHome)).toThrow('inside ~/.mango');
  });

  test('refuses a published value that points at the real home', () => {
    const real = join(host.realHome, '.mango');
    const env: NodeJS.ProcessEnv = { [SMOKE_HOME_ENV]: real };

    expect(() => prepareSmokeHome(env, host)).toThrow(`received: ${JSON.stringify(real)}`);
  });
});

describe('removeSmokeHome', () => {
  test('deletes a smoke directory with its contents', () => {
    const root = join(host.tmpDir, `${SMOKE_HOME_PREFIX}gone`);
    mkdirSync(join(root, '.mango'), { recursive: true });
    writeFileSync(join(root, '.mango', 'database.sqlite'), 'x');

    removeSmokeHome(root, host);

    expect(existsSync(root), `expected directory removed: ${root}`).toBe(false);
  });

  test('refuses to delete the real ~/.mango and leaves it in place', () => {
    const real = join(host.realHome, '.mango');
    writeFileSync(join(real, 'database.sqlite'), 'x');

    expect(() => removeSmokeHome(real, host)).toThrow('refusing smoke hub home');
    expect(existsSync(join(real, 'database.sqlite'))).toBe(true);
  });
});

describe('smoke home lifetime across process exit', () => {
  interface HomeProbe {
    status: number;
    home: string;
    canonicalHome: string;
    tmpDir: string;
    realHome: string;
  }

  /** Runs prepareSmokeHome in a fresh process on the real OS temp directory. */
  function runPrepare(published: string | undefined, tmpDir?: string): HomeProbe {
    const script = join(sandbox, 'prepare.ts');
    const modulePath = join(import.meta.dir, '../../tests/browser-smoke/support/smoke-home');
    writeFileSync(
      script,
      `import { prepareSmokeHome } from ${JSON.stringify(modulePath)};\n` +
        `import { realpathSync } from 'node:fs';\n` +
        `import { homedir, tmpdir } from 'node:os';\n` +
        `const home = prepareSmokeHome(process.env);\n` +
        `console.log(JSON.stringify({ home, canonicalHome: realpathSync(home), tmpDir: realpathSync(tmpdir()), realHome: realpathSync(homedir()) }));\n`
    );
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    delete env[SMOKE_HOME_ENV];
    if (published) env[SMOKE_HOME_ENV] = published;
    if (tmpDir) Object.assign(env, { TMPDIR: tmpDir, TEMP: tmpDir, TMP: tmpDir });
    const run = Bun.spawnSync([process.execPath, script], { env, stdout: 'pipe', stderr: 'pipe' });
    expect(run.exitCode, `prepareSmokeHome child stderr: ${run.stderr.toString()}`).toBe(0);
    return { status: run.exitCode ?? -1, ...JSON.parse(run.stdout.toString().trim()) };
  }

  test('deletes the directory it created when the process exits', () => {
    const { status, home, canonicalHome, tmpDir, realHome } = runPrepare(undefined);

    expect(status, `expected exit status: 0 | received: ${status}`).toBe(0);
    expect(dirname(canonicalHome)).toBe(tmpDir);
    expect(basename(canonicalHome).startsWith(SMOKE_HOME_PREFIX)).toBe(true);
    const fromRealHome = relative(realHome, canonicalHome);
    expect(
      fromRealHome === '..' || fromRealHome.startsWith(`..${sep}`) || isAbsolute(fromRealHome)
    ).toBe(true);
    expect(existsSync(home), `expected directory removed on exit: ${home}`).toBe(false);
  });

  test('uses its own temp directory through an alias and removes only its fresh home', () => {
    const alias = join(sandbox, 'child-temp-alias');
    symlinkSync(host.tmpDir, alias, 'junction');
    const { home, canonicalHome, tmpDir, realHome } = runPrepare(undefined, alias);

    expect(tmpDir).toBe(realpathSync(host.tmpDir));
    expect(dirname(canonicalHome)).toBe(tmpDir);
    expect(basename(canonicalHome).startsWith(SMOKE_HOME_PREFIX)).toBe(true);
    expect(() => assertTemporarySmokeHome(canonicalHome, { tmpDir, realHome })).not.toThrow();
    expect(existsSync(home)).toBe(false);
    expect(existsSync(host.tmpDir)).toBe(true);
  });

  test('never deletes a directory it was given through MANGO_SMOKE_HOME', () => {
    const given = join(tmpdir(), `${SMOKE_HOME_PREFIX}given-${process.pid}`);
    mkdirSync(given, { recursive: true });
    try {
      const { status, home } = runPrepare(given);

      expect(status, `expected exit status: 0 | received: ${status}`).toBe(0);
      expect(home).toBe(given);
      expect(existsSync(given), `expected directory kept after exit: ${given}`).toBe(true);
    } finally {
      rmSync(given, { recursive: true, force: true });
    }
  });
});

describe('smokeHubEnv', () => {
  const root = (): string => join(host.tmpDir, `${SMOKE_HOME_PREFIX}env`);

  test('moves HOME and every storage key into the smoke home', () => {
    const env = smokeHubEnv(root(), {}, host);
    const keys = [
      'HOME',
      'USERPROFILE',
      'MANGO_HOME',
      'DATABASE_PATH',
      'UPLOADS_DIR',
      'IMAGES_DIR',
      'TOOL_IMAGES_DIR',
      'AGENTS_DIR',
      'SKILLS_DIR',
      'CHECKPOINTS_DIR',
      'MANGO_LIBRARY_BACKUP_DIR',
      'MANGO_SECRET_STORE_UNSAFE_FILE_FALLBACK_DIR',
    ];

    for (const key of keys) {
      expect(
        env[key]?.startsWith(root()),
        `expected ${key} inside ${root()} | received: ${env[key]}`
      ).toBe(true);
    }
    expect(env.DATABASE_PATH).toBe(join(root(), '.mango', 'database.sqlite'));
  });

  test('binds the hub to loopback whatever the developer exported', () => {
    const env = smokeHubEnv(root(), { API_HOST: '0.0.0.0' }, host);

    expect(env.API_HOST, `expected API_HOST: ${SMOKE_HUB_HOST} | received: ${env.API_HOST}`).toBe(
      '127.0.0.1'
    );
  });

  test('ignores a developer-exported database path or hub home', () => {
    const env = smokeHubEnv(
      root(),
      {
        DATABASE_PATH: join(host.realHome, '.mango', 'database.sqlite'),
        MANGO_HOME: host.realHome,
      },
      host
    );

    expect(env.DATABASE_PATH).toBe(join(root(), '.mango', 'database.sqlite'));
    expect(env.MANGO_HOME).toBe(join(root(), '.mango'));
  });

  test('keeps the real cargo and rustup homes unless the developer moved them', () => {
    const defaults = smokeHubEnv(root(), {}, host);
    const moved = smokeHubEnv(
      root(),
      { CARGO_HOME: '/opt/cargo', RUSTUP_HOME: '/opt/rustup' },
      host
    );

    expect(defaults.CARGO_HOME).toBe(join(host.realHome, '.cargo'));
    expect(defaults.RUSTUP_HOME).toBe(join(host.realHome, '.rustup'));
    expect(moved.CARGO_HOME).toBe('/opt/cargo');
    expect(moved.RUSTUP_HOME).toBe('/opt/rustup');
  });

  test('refuses a root that is not a temporary smoke home', () => {
    expect(() => smokeHubEnv(host.realHome, {}, host)).toThrow('refusing smoke hub home');
  });
});
