/**
 * Guard for the browser-smoke lane: the hub it starts must live in a fresh
 * temporary home, never in the developer's real `~/.mango`.
 *
 * The suite signs up accounts and creates chats, so a hub that resolves its
 * database from the real home writes test data into (and could delete data
 * from) the developer's own MangoStudio. This reads the real
 * `playwright.config.ts` rather than a helper, because the config is what
 * actually decides what the hub inherits.
 *
 * The second block pins how the config orders the terminal spec against the
 * specs that sign up accounts. It lives here because it needs the same config
 * import, and the import creates the temporary home that `afterAll` removes.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
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

type DevelopmentConfig = (typeof import('../../playwright.config'))['default'];
type ProductionConfig = (typeof import('../../playwright.production.config'))['default'];

// Importing the config creates the temporary home (unless a runner published
// one). Note whether this process made it, so only that directory is removed.
// The import runs in `beforeAll`, not while the file is collected: `afterAll`
// does not run for a file whose tests are all filtered out, so a home made at
// collection time would stay behind in the temp directory.
let publishedBefore: string | undefined;
let config!: DevelopmentConfig;
let productionConfig!: ProductionConfig;

beforeAll(async () => {
  publishedBefore = process.env[SMOKE_HOME_ENV];
  config = (await import('../../playwright.config')).default;
  productionConfig = (await import('../../playwright.production.config')).default;
});

// Bun's test runner exits without running the 'exit' hook that removes the
// home a Playwright run creates, so remove the one the import created. A
// directory somebody exported as MANGO_SMOKE_HOME is theirs and stays.
afterAll(() => {
  if (publishedBefore) return;
  const created = process.env[SMOKE_HOME_ENV];
  if (created) removeSmokeHome(created);
  delete process.env[SMOKE_HOME_ENV];
});

type WebServer = Exclude<NonNullable<typeof config.webServer>, readonly unknown[]>;

const EXPECTED_SHAPE = join(tmpdir(), 'mangostudio-smoke-<random>');

function webServers(declared = config.webServer): WebServer[] {
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
  test('production reuses home, authentication and execution policy with a static root hub', () => {
    const development = webServers();
    const production = webServers(productionConfig.webServer);
    expect(development).toHaveLength(1);
    expect(production).toHaveLength(1);
    expect(development[0]?.command).toBe('bun run dev --api');
    expect(production[0]).toEqual({
      ...development[0],
      command: 'bun apps/api/src/index.ts serve',
      cwd: resolve(import.meta.dir, '../..'),
    });
    expect(productionConfig.globalSetup).toBe(config.globalSetup);
    expect(productionConfig.use).toEqual(config.use);
    expect(productionConfig.timeout).toBe(config.timeout);
    expect(productionConfig.retries).toBe(config.retries);
    expect(productionConfig.failOnFlakyTests).toBe(config.failOnFlakyTests);
    expect(productionConfig.workers).toBe(config.workers);
    expect(productionConfig.reporter).toEqual(config.reporter);
  });

  test('production keeps terminal first and limits the dependent project to rendering regressions', () => {
    expect(productionConfig.projects?.map((project) => project.name)).toEqual([
      'terminal',
      'chromium',
    ]);
    expect(productionConfig.projects?.[0]).toEqual(config.projects?.[0]);
    expect(productionConfig.projects?.[1]).toEqual({
      ...config.projects?.[1],
      testMatch: ['**/grid-late-card-state.spec.ts', '**/motion-presets.spec.ts'],
    });
    expect(productionConfig.projects?.[0]?.teardown).toBe('chromium');
    expect(productionConfig.projects?.[1]?.dependencies).toBeUndefined();
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
        `expected API_HOST: 127.0.0.1 | received: ${host || '(unset, the suite requires an explicit IPv4 loopback bind)'}`
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

/** The slice of a Playwright project the ordering rules read. */
interface OrderedProject {
  readonly name?: string;
  readonly testMatch?: unknown;
  readonly testIgnore?: unknown;
  readonly dependencies?: readonly string[];
  readonly teardown?: string;
}

const SMOKE_SPEC_DIR = resolve(import.meta.dir, '../../tests/browser-smoke');
const TERMINAL_SPEC = resolve(SMOKE_SPEC_DIR, 'terminal.spec.ts');

/**
 * Specs that create an account on the hub: a second account connecting to Local
 * is what withdraws the single-user-host attestation the terminal needs.
 * `sign-up/email` is the endpoint, `/signup` the page `auth-flow.spec.ts` fills
 * in, and `newSignedInContext` the helper behind the rest.
 */
const SIGNS_UP_ACCOUNT = /sign-up\/email|newSignedInContext|\/signup/;

function specsThatSignUp(): string[] {
  return readdirSync(SMOKE_SPEC_DIR)
    .filter((file) => file.endsWith('.spec.ts'))
    .map((file) => resolve(SMOKE_SPEC_DIR, file))
    .filter((file) => SIGNS_UP_ACCOUNT.test(readFileSync(file, 'utf8')));
}

function matchesPattern(pattern: unknown, file: string, field: string): boolean {
  if (pattern === undefined) return false;
  if (pattern instanceof RegExp) return pattern.test(file);
  // Playwright matches globs against the absolute path, like the production
  // config's `**/name.spec.ts` entries.
  if (typeof pattern === 'string') return new Bun.Glob(pattern).match(file);
  if (Array.isArray(pattern)) return pattern.some((entry) => matchesPattern(entry, file, field));
  throw new Error(
    `expected ${field}: RegExp, glob string or an array of them | received: ${JSON.stringify(pattern)}`
  );
}

/** Whether Playwright would run `file` in `project`: no `testMatch` means every spec. */
function runsFile(project: OrderedProject, file: string): boolean {
  const matched =
    project.testMatch === undefined || matchesPattern(project.testMatch, file, 'testMatch');
  return matched && !matchesPattern(project.testIgnore, file, 'testIgnore');
}

/**
 * What is wrong with how `projects` order the terminal spec, as sentences; an
 * empty list means the ordering holds.
 *
 * The terminal spec has to run before any spec that signs up an account, and a
 * failed terminal run must not stop those specs. Playwright skips a project
 * whose `dependencies` failed, so the order comes from the terminal project's
 * `teardown` instead: it runs after the project finishes, pass or fail.
 */
function orderingProblems(
  projects: readonly OrderedProject[],
  signingUpSpecs: readonly string[]
): string[] {
  const problems: string[] = [];
  const terminalProjects = projects.filter((project) => runsFile(project, TERMINAL_SPEC));
  const [terminal] = terminalProjects;
  if (terminalProjects.length !== 1 || !terminal?.name) {
    return [
      `expected exactly one named project running terminal.spec.ts | received: ${terminalProjects.map((p) => p.name ?? '(unnamed)').join(', ') || 'none'}`,
    ];
  }
  for (const project of projects) {
    if (project.dependencies?.includes(terminal.name)) {
      problems.push(
        `expected no project depending on "${terminal.name}" | received: "${project.name}" (a failed terminal run would skip it)`
      );
    }
  }
  const follower = projects.find((project) => project.name === terminal.teardown);
  if (!follower || follower === terminal) {
    problems.push(
      `expected "${terminal.name}" teardown: the project that runs the signing-up specs after it | received: ${String(terminal.teardown)}`
    );
    return problems;
  }
  for (const spec of signingUpSpecs) {
    if (runsFile(terminal, spec)) {
      problems.push(`expected ${spec} outside "${terminal.name}" | received: it runs there`);
    } else if (!runsFile(follower, spec)) {
      problems.push(
        `expected ${spec} in "${follower.name}", which runs after "${terminal.name}" | received: no project runs it after the terminal spec`
      );
    }
  }
  return problems;
}

describe('browser smoke project ordering', () => {
  const developmentProjects = (): readonly OrderedProject[] =>
    (config.projects ?? []) as readonly OrderedProject[];

  test('finds the specs that sign up accounts, including the ones added after the terminal project', () => {
    const names = specsThatSignUp().map((file) => file.slice(SMOKE_SPEC_DIR.length + 1));
    expect(names).toEqual(
      expect.arrayContaining(['auth-flow.spec.ts', 'two-tab-rename.spec.ts', 'lazy-panel.spec.ts'])
    );
    expect(names).not.toContain('terminal.spec.ts');
  });

  test('the development config runs the terminal spec first and every signing-up spec after it', () => {
    expect(orderingProblems(developmentProjects(), specsThatSignUp())).toEqual([]);
  });

  test('the production config keeps the same ordering for the projects it keeps', () => {
    const production = (productionConfig.projects ?? []) as readonly OrderedProject[];
    expect(production.find((project) => project.name === 'terminal')?.teardown).toBe('chromium');
    expect(orderingProblems(production, [])).toEqual([]);
  });

  test('reports a project that depends on the terminal project', () => {
    const failClosed: OrderedProject[] = developmentProjects().map((project) =>
      project.name === 'chromium' ? { ...project, dependencies: ['terminal'] } : project
    );
    expect(orderingProblems(failClosed, specsThatSignUp())).toContainEqual(
      expect.stringContaining('expected no project depending on "terminal" | received: "chromium"')
    );
  });

  test('reports a terminal project that nothing is ordered after', () => {
    const unordered: OrderedProject[] = developmentProjects().map((project) => {
      const { teardown: _removed, ...rest } = project;
      return rest;
    });
    expect(orderingProblems(unordered, specsThatSignUp())).toContainEqual(
      expect.stringContaining('expected "terminal" teardown')
    );
  });

  test('reports a signing-up spec that shares the terminal project', () => {
    const [signUp] = specsThatSignUp();
    const merged: OrderedProject[] = [
      { name: 'terminal', teardown: 'chromium', testMatch: /\.spec\.ts$/ },
      { name: 'chromium', testIgnore: /terminal\.spec\.ts$/ },
    ];
    expect(orderingProblems(merged, [signUp as string])).toEqual([
      expect.stringContaining('outside "terminal" | received: it runs there'),
    ]);
  });
});
