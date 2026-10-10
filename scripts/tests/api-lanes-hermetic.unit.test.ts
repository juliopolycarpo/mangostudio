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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { REAL_HOME_ENV, TEST_HOME_PREFIX, testHomeEnv } from '../lib/test-home';
import { canonicalPath as canonical } from './support/canonical-path';

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
  test('canonicalizes a removed test home through a temp directory alias', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'api-home-alias-'));
    try {
      const physical = join(sandbox, 'physical');
      const alias = join(sandbox, 'alias');
      mkdirSync(physical);
      symlinkSync(physical, alias, 'junction');
      const home = mkdtempSync(join(alias, TEST_HOME_PREFIX));
      const expected = realpathSync(home);
      rmSync(home, { recursive: true });
      expect(canonical(home)).toBe(expected);
      expect(dirname(canonical(home))).toBe(canonical(physical));
      expect(isInside(canonical(home), canonical(realHome))).toBe(false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  for (const name of LANE_SCRIPTS) {
    test(`apps/api ${name} resolves homedir() inside a fresh temporary directory`, async () => {
      const launcher = launcherCommand(scripts[name] ?? '');
      if (!launcher) throw new Error(`apps/api ${name} has no launcher; see the script pins above`);
      const probe = Bun.spawn({
        cmd: [
          ...launcher,
          'bun',
          '-e',
          'const { homedir, tmpdir } = require("node:os"); const { realpathSync } = require("node:fs"); console.log(JSON.stringify({ home: homedir(), canonicalHome: realpathSync(homedir()), tmpDir: realpathSync(tmpdir()) }))',
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
      const { home, canonicalHome, tmpDir } = JSON.parse(
        out.trim().split('\n').at(-1) as string
      ) as {
        home: string;
        canonicalHome: string;
        tmpDir: string;
      };

      expect(canonical(home), 'expected removed home to retain its canonical OS path').toBe(
        canonicalHome
      );
      const canonicalRealHome = canonical(realHome);
      const usable =
        dirname(canonicalHome) === canonical(tmpDir) &&
        !isInside(canonicalRealHome, canonicalHome) &&
        !isInside(canonicalHome, canonicalRealHome) &&
        basename(canonicalHome).startsWith(TEST_HOME_PREFIX);
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

/**
 * What Turbo makes of the lanes. The launcher is not part of `apps/api`, and
 * Turbo runs tasks with a strict environment, so both of these fail silently:
 * a launcher edit is served a stale cached pass, and a developer's
 * `CARGO_HOME` / `RUSTUP_HOME` / `BUN_INSTALL` never reaches the launcher that
 * pins them. `turbo run --dry=json` is Turbo's own answer, after it has merged
 * the root and workspace task definitions.
 *
 * Why `apps/api/turbo.json` is shaped the way it is (it stays comment-free, strict
 * JSON, so every tool parses it):
 * - Only `test:unit` is cached. The launcher lives outside the workspace, so it
 *   is named in `inputs` through `$TURBO_ROOT$`; `$TURBO_DEFAULT$` stays because
 *   an explicit list replaces the tracked package files.
 * - The toolchain homes are `passThroughEnv`, not `env`: they steer where tools
 *   live, not what a test sees, so they must stay out of the cache key.
 */
describe('Turbo task definitions of the API lanes', () => {
  /** The variables the launcher pins to the developer's real locations. */
  const PINNED_TOOLCHAIN_VARS = [
    'CARGO_HOME',
    'RUSTUP_HOME',
    'BUN_INSTALL',
    'BUN_INSTALL_CACHE_DIR',
  ];
  const TURBO_LANES = ['test:unit', 'test:integration', 'test:coverage'];

  interface DryRunTask {
    taskId: string;
    inputs: Record<string, string>;
    resolvedTaskDefinition: { cache: boolean; passThroughEnv: string[] | null };
  }

  /** The `scripts/` files the launcher loads: its own and every relative import, transitively. */
  function launcherFiles(entry = 'scripts/with-test-home.ts', seen = new Set<string>()): string[] {
    if (seen.has(entry)) return [...seen];
    seen.add(entry);
    const source = readFileSync(join(ROOT, entry), 'utf8');
    for (const match of source.matchAll(/from '(\.{1,2}\/[^']+)'/g)) {
      launcherFiles(posix.join(posix.dirname(entry), `${match[1]}.ts`), seen);
    }
    return [...seen];
  }

  async function dryRun(): Promise<Map<string, DryRunTask>> {
    const turbo = join(ROOT, 'node_modules', '.bin', 'turbo');
    const probe = Bun.spawn({
      cmd: [turbo, 'run', ...TURBO_LANES, '--filter=@mangostudio/api', '--dry=json'],
      cwd: ROOT,
      env: process.env as Record<string, string>,
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
    const { tasks } = JSON.parse(out) as { tasks: DryRunTask[] };
    return new Map(tasks.map((task) => [task.taskId.replace('@mangostudio/api#', ''), task]));
  }

  test('the launcher closure is the three files the cache key names', () => {
    expect(launcherFiles().sort()).toEqual([
      'scripts/lib/temp-home.ts',
      'scripts/lib/test-home.ts',
      'scripts/with-test-home.ts',
    ]);
  });

  test('the cached test:unit lane hashes every launcher file', async () => {
    const task = (await dryRun()).get('test:unit');
    expect(task, 'expected a @mangostudio/api#test:unit task in the Turbo dry run').toBeDefined();
    expect(
      task?.resolvedTaskDefinition.cache,
      'expected test:unit to be cached, which is why its inputs matter'
    ).toBe(true);

    const hashed = Object.keys(task?.inputs ?? {});
    for (const file of launcherFiles()) {
      expect(
        hashed.includes(`../../${file}`),
        `a change to ${file} must invalidate the cached @mangostudio/api test:unit result | expected: "$TURBO_ROOT$/${file}" in the task's inputs in apps/api/turbo.json | received: ${hashed.length} hashed files, none of them ../../${file}`
      ).toBe(true);
    }
    expect(
      hashed.includes('package.json'),
      'an explicit inputs list replaces the tracked package files | expected: "$TURBO_DEFAULT$" kept in the inputs | received: apps/api/package.json not hashed'
    ).toBe(true);
  });

  test('every lane passes the pinned toolchain variables through', async () => {
    const tasks = await dryRun();
    for (const name of TURBO_LANES) {
      const passThrough = tasks.get(name)?.resolvedTaskDefinition.passThroughEnv ?? [];
      for (const variable of PINNED_TOOLCHAIN_VARS) {
        expect(
          passThrough,
          `Turbo's strict environment drops ${variable} before ${LAUNCHER} sees it, so a non-default location is replaced by the home-directory default | expected: "${variable}" in passThroughEnv of @mangostudio/api ${name} | received: [${passThrough.join(', ')}]`
        ).toContain(variable);
      }
    }
  });

  test('the pass-through list covers every toolchain variable the launcher pins', () => {
    const pinned = Object.keys(testHomeEnv('/tmp/x', {}, { tmpDir: '/tmp', realHome: '/h' }));
    for (const variable of PINNED_TOOLCHAIN_VARS) {
      expect(pinned, `expected the launcher to pin ${variable}`).toContain(variable);
    }
  });
});
