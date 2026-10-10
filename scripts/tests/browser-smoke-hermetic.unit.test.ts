/**
 * Guard for the browser-smoke lane: the hub it starts must live in a fresh
 * temporary home, never in the developer's real `~/.mango`.
 *
 * The suite signs up accounts and creates chats, so a hub that resolves its
 * database from the real home writes test data into (and could delete data
 * from) the developer's own MangoStudio. This reads the real
 * `playwright.config.ts` rather than a helper, because the config is what
 * actually decides what the hub inherits.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { removeSmokeHome, SMOKE_HOME_ENV } from '../../tests/browser-smoke/support/smoke-home';
import { canonicalPath as canonical } from './support/canonical-path';

/** Env keys that place hub state; each must resolve inside the temporary home. */
const HOME_KEYS = [
  'HOME',
  'MANGO_HOME',
  'DATABASE_PATH',
  'UPLOADS_DIR',
  'CHECKPOINTS_DIR',
] as const;

// Importing the config creates the temporary home (unless a runner published
// one). Note whether this process made it, so only that directory is removed.
const publishedBefore = process.env[SMOKE_HOME_ENV];
const { default: config } = await import('../../playwright.config');

type WebServer = Exclude<NonNullable<typeof config.webServer>, readonly unknown[]>;

const EXPECTED_SHAPE = join(tmpdir(), 'mangostudio-smoke-<random>');

function webServers(): WebServer[] {
  const declared = config.webServer;
  if (!declared) return [];
  return Array.isArray(declared) ? declared : [declared];
}

/** What the hub process sees: the webServer env layered over the ambient env. */
function effectiveEnv(server: WebServer, key: string): string {
  const override = server.env?.[key];
  return override ?? process.env[key] ?? '';
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

describe('browser smoke lane hermeticity', () => {
  // Bun's test runner exits without running the 'exit' hook that removes the
  // home a Playwright run creates, so remove the one this import created. A
  // directory somebody exported as MANGO_SMOKE_HOME is theirs and stays.
  afterAll(() => {
    if (publishedBefore) return;
    const created = process.env[SMOKE_HOME_ENV];
    if (created) removeSmokeHome(created);
    delete process.env[SMOKE_HOME_ENV];
  });

  test('declares a web server to guard', () => {
    expect(
      webServers().length,
      'expected webServer entries: >= 1 | received: none'
    ).toBeGreaterThan(0);
  });

  test('canonicalizes future storage paths through a temp directory alias', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'smoke-storage-alias-'));
    try {
      const physical = join(sandbox, 'physical');
      const alias = join(sandbox, 'alias');
      mkdirSync(physical);
      symlinkSync(physical, alias, 'junction');
      const future = join(alias, 'mangostudio-smoke-fresh', '.mango', 'uploads');
      expect(canonical(future)).toBe(
        join(realpathSync(physical), 'mangostudio-smoke-fresh', '.mango', 'uploads')
      );
      expect(isInside(canonical(physical), canonical(future))).toBe(true);
      expect(isInside(canonical(future), canonical(physical))).toBe(false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  for (const key of HOME_KEYS) {
    test(`${key} of the smoke hub resolves inside a temporary directory`, () => {
      const realMangoDir = canonical(join(homedir(), '.mango'));
      const temporaryRoot = canonical(tmpdir());
      const smokeHome = canonical(process.env[SMOKE_HOME_ENV] ?? '');

      for (const server of webServers()) {
        const resolved = effectiveEnv(server, key);
        const usable =
          resolved !== '' &&
          isInside(temporaryRoot, canonical(resolved)) &&
          isInside(smokeHome, canonical(resolved));
        expect(
          usable && !isInside(realMangoDir, canonical(resolved)),
          `smoke hub ${key} must be a fresh temporary path | expected shape: ${EXPECTED_SHAPE}/... | resolved: ${resolved || '(unset, inherits the real home)'} | real home: ${realMangoDir}`
        ).toBe(true);
      }
    });
  }

  test('binds the smoke hub to loopback only', () => {
    for (const server of webServers()) {
      const host = effectiveEnv(server, 'API_HOST');
      expect(
        host,
        `expected API_HOST: 127.0.0.1 | received: ${host || '(unset, the hub binds 0.0.0.0)'}`
      ).toBe('127.0.0.1');
    }
  });

  test('never attaches to an already running hub', () => {
    for (const server of webServers()) {
      expect(
        server.reuseExistingServer,
        `expected reuseExistingServer: false | received: ${String(server.reuseExistingServer)} (a running dev hub uses the real home)`
      ).toBe(false);
    }
  });
});
