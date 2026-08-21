/**
 * Guards the `bun test` lane's resolver aliases, which nothing else can see.
 *
 * `Bun.build()` honours `tsconfig.json` `paths` — measured: a `motion/react`
 * entry there put the test stub's code in the production bundle, with a green
 * `check`, `test` and `build`. So the aliases live in `tsconfig.test.json`,
 * reached only through `bun test --tsconfig-override`. Two things then need
 * asserting, and neither is visible to `tsc`, biome or knip: that the override
 * is actually in effect when the lane runs, and that nobody has moved an alias
 * back into the config the bundler reads.
 *
 * `bunfig.toml`'s `[test] tsconfig` key looks like it would do the same job.
 * It is accepted and silently ignored — the real `motion/react` resolves and
 * every test still passes, just against animations that no longer settle
 * synchronously.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { authClient, setTestSession } from '../support/setup/auth-client-stub';

const WORKSPACE_ROOT = resolve(import.meta.dir, '../..');

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(WORKSPACE_ROOT, relativePath), 'utf8')) as T;
}

interface TsConfig {
  compilerOptions?: { paths?: Record<string, string[]> };
}

describe('bun lane resolver aliases', () => {
  it('resolves motion/react to the synchronous stub', async () => {
    const motionModule = (await import('motion/react')) as Record<string, unknown>;

    // The real package exports hundreds of names; the stub exports two. Naming
    // them beats counting, so a stub that grows an export does not fail this.
    expect(Object.keys(motionModule).sort()).toEqual(['AnimatePresence', 'motion']);
  });

  it('resolves @/lib/auth-client to the stub, which reports signed out by default', async () => {
    // `tsc` reads the app tsconfig, where `@/lib/auth-client` is the real
    // client, so the import is typed as the thing this alias replaces.
    const aliased = (await import('@/lib/auth-client')).authClient as unknown as typeof authClient;

    // Same module instance as the relative import, or `setTestSession` from a
    // test would not reach the component that read `@/lib/auth-client`.
    expect(aliased).toBe(authClient);
    expect(aliased.useSession()).toEqual({ data: null, isPending: false });

    setTestSession({ user: { id: 'user-guard' } });
    expect(aliased.useSession().data).toEqual({ user: { id: 'user-guard' } });
    // `bun.setup.ts`'s afterEach resets this; no cleanup needed here.
  });

  it('keeps every alias out of the tsconfig the bundler reads', () => {
    const appPaths = readJson<TsConfig>('tsconfig.json').compilerOptions?.paths ?? {};

    expect(Object.keys(appPaths)).toEqual(['@/*']);
  });

  it('restates the app aliases, because paths do not merge through extends', () => {
    const appPaths = readJson<TsConfig>('tsconfig.json').compilerOptions?.paths ?? {};
    const testPaths = readJson<TsConfig>('tsconfig.test.json').compilerOptions?.paths ?? {};

    for (const [pattern, targets] of Object.entries(appPaths)) {
      expect(testPaths[pattern]).toEqual(targets);
    }
  });

  it('points every test alias at a file that exists', () => {
    const testPaths = readJson<TsConfig>('tsconfig.test.json').compilerOptions?.paths ?? {};
    const missing = Object.entries(testPaths)
      .filter(([pattern]) => !pattern.endsWith('*'))
      .flatMap(([, targets]) => targets)
      .filter((target) => !existsSync(join(WORKSPACE_ROOT, target)));

    expect(missing).toEqual([]);
  });
});

describe('bun lane file list', () => {
  const bunLaneFiles = readJson<{ scripts: Record<string, string> }>('package.json')
    .scripts['test:unit:bun'].split(/\s+/)
    .filter((argument) => /^tests\/.+\.tsx?$/.test(argument));

  it('is what vitest.config.ts derives its exclusion from', () => {
    const config = readFileSync(join(WORKSPACE_ROOT, 'vitest.config.ts'), 'utf8');

    expect(config).toContain('...bunLaneFiles()');
  });

  it('names files that exist', () => {
    // `bun test` treats an unmatched pattern as zero files and still exits 0,
    // so a typo here silently drops a file from both lanes at once.
    expect(bunLaneFiles.filter((file) => !existsSync(join(WORKSPACE_ROOT, file)))).toEqual([]);
    expect(bunLaneFiles.length).toBeGreaterThan(1);
  });

  it('runs the setup files bunfig.toml preloads, in the documented order', () => {
    const bunfig = readFileSync(join(WORKSPACE_ROOT, 'bunfig.toml'), 'utf8');
    const preload = bunfig.match(/^preload = \[(.+)\]$/m)?.[1] ?? '';
    const files = [...preload.matchAll(/"([^"]+)"/g)].map((match) => match[1]);

    expect(files).toEqual([
      './tests/support/setup/dom-setup.ts',
      './tests/support/setup/bun.setup.ts',
    ]);
    // The registrar must not reach `@testing-library/*`, directly or through an
    // import, or `screen` initializes before `document` exists.
    const domSetup = readFileSync(join(WORKSPACE_ROOT, files[0]), 'utf8');
    const imported = [...domSetup.matchAll(/^import[^'"]+['"]([^'"]+)['"]/gm)].map(
      (match) => match[1]
    );
    expect(imported.filter((specifier) => specifier.startsWith('@testing-library'))).toEqual([]);
    expect(dirname(files[0])).toBe(dirname(files[1]));
  });
});
