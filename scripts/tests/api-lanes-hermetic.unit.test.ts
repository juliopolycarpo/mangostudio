/**
 * Guard for the API test lanes: their `bun test` processes must start with a
 * fresh temporary HOME, never the developer's real one.
 *
 * The API unit and integration suites create and read `~/.mango` and
 * `~/.claude`, so a lane that inherits the real home writes test data into the
 * developer's own MangoStudio and passes or fails by what happens to be
 * installed there. Bun honours `HOME` only when a process starts, so this reads
 * the real launcher — the `test:*` scripts in `apps/api/package.json` — and
 * runs it, rather than checking a helper in isolation.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { REAL_HOME_ENV, TEST_HOME_PREFIX } from '../lib/test-home';

const ROOT = join(import.meta.dir, '..', '..');
const API_DIR = join(ROOT, 'apps', 'api');
const LAUNCHER = 'scripts/with-test-home.ts';

/** The lane scripts that start `bun test`, which must all go through the launcher. */
const LANE_SCRIPTS = [
  'test:unit',
  'test:integration',
  'test:coverage:unit',
  'test:coverage:integration',
];

const EXPECTED_SHAPE = join(tmpdir(), `${TEST_HOME_PREFIX}<random>`);

const scripts = JSON.parse(readFileSync(join(API_DIR, 'package.json'), 'utf8')).scripts as Record<
  string,
  string
>;

/** The developer's real home: the one an outer launcher recorded, else this process's own. */
const realHome = process.env[REAL_HOME_ENV]?.trim() || homedir();

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/** What precedes `bun test` in a lane script, e.g. `... bun ../../scripts/with-test-home.ts`. */
function launcherCommand(script: string): string[] | null {
  const match = /(\S+\/with-test-home\.ts)\s+bun test\b/.exec(script);
  return match?.[1] ? [process.execPath, match[1]] : null;
}

describe('API lane scripts start bun test through the temporary-home launcher', () => {
  for (const name of LANE_SCRIPTS) {
    test(`apps/api ${name}`, () => {
      const script = scripts[name] ?? '';

      expect(
        launcherCommand(script),
        `apps/api ${name} must start bun test through ${LAUNCHER}, which gives the lane a temporary HOME | expected: ... bun ../../${LAUNCHER} bun test ... | received: ${script || '(script missing)'}`
      ).not.toBeNull();
    });
  }

  test('no other apps/api script starts a bare bun test', () => {
    for (const [name, script] of Object.entries(scripts)) {
      if (!/\bbun test\b/.test(script)) continue;
      expect(
        launcherCommand(script),
        `apps/api script ${name} runs bun test with the real home | expected: through ${LAUNCHER} | received: ${script}`
      ).not.toBeNull();
    }
  });

  test('the nightly randomized-order lane goes through the launcher too', () => {
    const workflow = readFileSync(
      join(ROOT, '.github', 'workflows', 'randomized-order-nightly.yml'),
      'utf8'
    );

    expect(
      workflow,
      `randomized-order-nightly.yml must start bun test through ${LAUNCHER} | expected: -- bun ../../${LAUNCHER} bun test`
    ).toContain(`-- bun ../../${LAUNCHER} bun test`);
  });
});

describe('what an API lane process sees as its home', () => {
  for (const name of LANE_SCRIPTS) {
    test(`apps/api ${name} resolves homedir() inside a fresh temporary directory`, async () => {
      const launcher = launcherCommand(scripts[name] ?? '');
      if (!launcher) throw new Error(`apps/api ${name} has no launcher; see the script pins above`);
      const probe = Bun.spawn({
        cmd: [
          ...launcher,
          'bun',
          '-e',
          'console.log(JSON.stringify({ home: require("node:os").homedir() }))',
        ],
        cwd: API_DIR,
        env: process.env as Record<string, string>,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [out, err, code] = await Promise.all([
        new Response(probe.stdout).text(),
        new Response(probe.stderr).text(),
        probe.exited,
      ]);
      expect(code, `expected launcher exit: 0 | received: ${code} | stderr: ${err.trim()}`).toBe(0);
      const { home } = JSON.parse(out.trim().split('\n').at(-1) as string) as { home: string };

      const usable =
        isInside(canonical(tmpdir()), canonical(home)) &&
        !isInside(realHome, home) &&
        !isInside(home, realHome) &&
        home.includes(TEST_HOME_PREFIX);
      expect(
        usable,
        `apps/api ${name} must start tests with a fresh temporary home | expected shape: ${EXPECTED_SHAPE} | resolved homedir(): ${home} | real home: ${realHome}`
      ).toBe(true);
      expect(existsSync(home), `expected the test home removed | still exists: ${home}`).toBe(
        false
      );
    });
  }
});

describe('preload abort', () => {
  const preload = readFileSync(join(API_DIR, 'tests', 'support', 'setup', 'preload.ts'), 'utf8');
  const check = readFileSync(
    join(API_DIR, 'tests', 'support', 'setup', 'hermetic-home.ts'),
    'utf8'
  );

  test('the preload runs the home check', () => {
    expect(
      preload,
      'apps/api preload must call assertHermeticHome() before it prepares the environment | expected: assertHermeticHome()'
    ).toContain('assertHermeticHome();');
  });

  test('the check reads the variable the launcher sets', () => {
    expect(
      check,
      `apps/api hermetic-home.ts must read ${REAL_HOME_ENV}, the variable ${LAUNCHER} sets | expected: '${REAL_HOME_ENV}'`
    ).toContain(`'${REAL_HOME_ENV}'`);
  });
});
