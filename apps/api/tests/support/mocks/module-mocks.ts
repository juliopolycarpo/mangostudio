/**
 * The one way an API test replaces a module: `moduleMockerFor(import.meta.dir)`
 * returns a `mockModule(specifier, factory)` that stands in for `mock.module()`.
 *
 * `mock.restore()` does not revert `mock.module()`, and a registration outlives
 * the file that made it in the unisolated `api-integration` lane. Undoing one
 * means re-registering the real namespace, which only works if it was captured
 * before the first fake went in. This module does both halves, so no suite keeps
 * a list of what it faked:
 *
 * - the first `mockModule()` call for a module snapshots the real namespace
 *   (whole, not a hand-listed subset: `mock.module()` on a loaded module merges,
 *   so a partial restore would leave the rest of the fake installed);
 * - `test-environment.ts` runs `restoreMockedModules()` from a global `afterEach`,
 *   which re-registers the snapshot of every module faked since the last drain.
 *
 * `tests/unit/support/module-mock-guard.test.ts` fails on any `mock.module(` in
 * `apps/api/tests` outside this file, and on any other way a file that imports
 * `mock` from `bun:test` can reach `module` through it (`mock['module']`,
 * `const { module } = mock`, an alias or re-export of `mock`), so a new fake cannot
 * skip the registry.
 *
 * ## Consequences for a suite
 *
 * - The drain is per test. A fake installed in `beforeAll`, or at module scope,
 *   is gone after the first test: install it in `beforeEach` or in the test.
 * - A relative specifier resolves against the `baseDir` handed to
 *   `moduleMockerFor`, never against the calling support module. Bun resolves a
 *   bare `mock.module('../x')` against the running test file, which made a shared
 *   helper correct only for test files at its own directory depth.
 *
 * ## Why this module imports nothing mockable
 *
 * It is pulled into the bunfig preload's module graph through
 * `test-environment.ts`. A module in that graph that a test mocks is re-evaluated
 * by the mock and yields a second, uninitialized `test-environment.ts` (see
 * docs/reference/testing.md, "Never add a direct import of a mocked module to the
 * bunfig preload", for the measurement). `bun:test` is the only import here, and
 * `preload.ts` itself still imports only its `./` siblings.
 */

import { mock } from 'bun:test';

/** Same shape `mock.module` accepts: a factory returning the fake namespace. */
type ModuleFactory = () => object;

/** Installs `factory` as the module registered under `id`: `mock.module` by default. */
export type ModuleRegistrar = (id: string, factory: ModuleFactory) => unknown;

/** The real registrar. A test hands `restoreMockedModules` a fake one to make a restore fail. */
export const registerWithBun: ModuleRegistrar = (id, factory) => mock.module(id, factory);

/** Snapshots of the real namespaces, keyed by the id handed to `mock.module`. */
const realNamespaces = new Map<string, object>();
/** Ids faked since the last drain: the only ones a drain has to re-register. */
const fakedSinceDrain = new Set<string>();

/**
 * The id `mock.module` and `import()` both accept. Relative specifiers become
 * absolute paths against `baseDir`; packages and `node:` builtins pass through.
 */
function resolveModuleId(specifier: string, baseDir: string): string {
  if (!specifier.startsWith('.')) return specifier;
  try {
    return Bun.resolveSync(specifier, baseDir);
  } catch (error) {
    throw new Error(
      `mockModule: expected a specifier that resolves from ${baseDir} | received: ${specifier} (${error instanceof Error ? error.message : String(error)})`,
      { cause: error }
    );
  }
}

/**
 * Binds `mockModule` to the directory its relative specifiers are written
 * against. // Usage: const mockModule = moduleMockerFor(import.meta.dir);
 */
export function moduleMockerFor(baseDir: string) {
  return async function mockModule(specifier: string, factory: ModuleFactory): Promise<void> {
    const id = resolveModuleId(specifier, baseDir);
    if (!realNamespaces.has(id)) {
      // Before the first fake: after it, a namespace spread reads the fake.
      realNamespaces.set(id, { ...(await import(id)) });
    }
    fakedSinceDrain.add(id);
    await mock.module(id, factory);
  };
}

/**
 * Re-registers the real namespace of every module faked since the previous call.
 * The global `afterEach` calls it; a test that needs the real module mid-test
 * can too. // Usage: await restoreMockedModules()
 *
 * An id leaves the pending set only after its re-registration succeeded, and every
 * id is attempted even when an earlier one failed, so one bad module cannot leave
 * the rest faked and forgotten. Failures are reported together as an
 * `AggregateError`; the failed ids stay pending for the next call.
 */
export async function restoreMockedModules(
  registerModule: ModuleRegistrar = registerWithBun
): Promise<void> {
  const failures: Error[] = [];
  for (const id of [...fakedSinceDrain]) {
    try {
      const real = realNamespaces.get(id);
      if (!real) throw new Error('expected a snapshot | none taken');
      await registerModule(id, () => real);
      fakedSinceDrain.delete(id);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      failures.push(new Error(`${id}: ${reason}`, { cause }));
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `restoreMockedModules: expected every faked module to be re-registered | failed: ${failures.map((failure) => failure.message).join('; ')}`
    );
  }
}
