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

import { describe, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import config from '../../playwright.config';

/** Env keys that place hub state; each must resolve inside the temporary home. */
const HOME_KEYS = [
  'HOME',
  'MANGO_HOME',
  'DATABASE_PATH',
  'UPLOADS_DIR',
  'CHECKPOINTS_DIR',
] as const;

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

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

describe('browser smoke lane hermeticity', () => {
  test('declares a web server to guard', () => {
    expect(
      webServers().length,
      'expected webServer entries: >= 1 | received: none'
    ).toBeGreaterThan(0);
  });

  for (const key of HOME_KEYS) {
    test(`${key} of the smoke hub resolves inside a temporary directory`, () => {
      const realMangoDir = join(homedir(), '.mango');
      const temporaryRoot = canonical(tmpdir());

      for (const server of webServers()) {
        const resolved = effectiveEnv(server, key);
        const usable = resolved !== '' && isInside(temporaryRoot, canonical(resolved));
        expect(
          usable && !isInside(realMangoDir, resolved),
          `smoke hub ${key} must be a fresh temporary path | expected shape: ${EXPECTED_SHAPE}/... | resolved: ${resolved || '(unset, inherits the real home)'} | real home: ${realMangoDir}`
        ).toBe(true);
      }
    });
  }

  test('never attaches to an already running hub', () => {
    for (const server of webServers()) {
      expect(
        server.reuseExistingServer,
        `expected reuseExistingServer: false | received: ${String(server.reuseExistingServer)} (a running dev hub uses the real home)`
      ).toBe(false);
    }
  });
});
