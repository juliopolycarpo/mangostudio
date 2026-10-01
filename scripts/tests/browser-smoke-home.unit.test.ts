import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertTemporarySmokeHome,
  describeSmokeHomeShape,
  prepareSmokeHome,
  removeSmokeHome,
  SMOKE_HOME_ENV,
  SMOKE_HOME_PREFIX,
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
