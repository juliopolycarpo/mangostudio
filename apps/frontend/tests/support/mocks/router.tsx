/**
 * Stands in for TanStack Router's `Link` as a plain anchor.
 *
 * Router-only props are stripped so they never land on the DOM element;
 * everything else (className, aria-*, data-*) passes through to the anchor.
 *
 * The `mock.module('@tanstack/react-router', …)` call must stay in each test
 * file: `bun test` shares one module graph across files, so a preload-level
 * module mock would leak into every other file in the run.
 */

import { mock } from 'bun:test';

import type { ReactNode } from 'react';

// Captured when this module is first evaluated, which is before the importing
// file's body can register a fake: static imports run first. It is a copy of
// the namespace, not the namespace itself, because `mock.module()` on a loaded
// module merges into the live one and would overwrite what a live reference
// holds (`docs/reference/testing.md`, "mock.restore() does not revert mock.module()").
const realRouter = { ...(await import('@tanstack/react-router')) };

/**
 * Puts the real router back after a file replaced it with {@link routerWithLinkStub}.
 * `mock.module()` outlives the file that made it, so a fake installed here
 * would otherwise reach every file scheduled after this one in an unisolated
 * run, and a directory run would depend on `--isolate` for correctness.
 *
 * Call it once the file is done, not between tests: the routes under test are
 * imported while the fake is installed and keep working off it.
 *
 * // Usage: afterAll(restoreRouter);
 */
export async function restoreRouter(): Promise<void> {
  await mock.module('@tanstack/react-router', () => realRouter);
}

export function LinkStub({
  to,
  children,
  activeProps: _activeProps,
  inactiveProps: _inactiveProps,
  activeOptions: _activeOptions,
  params: _params,
  ...props
}: {
  to: string;
  children?: ReactNode;
  activeProps?: unknown;
  inactiveProps?: unknown;
  activeOptions?: unknown;
  params?: unknown;
  [k: string]: unknown;
}) {
  return (
    <a href={to} {...props}>
      {children}
    </a>
  );
}

/**
 * The real router namespace with `Link` replaced by {@link LinkStub}, as the
 * factory `mock.module` wants and with the `await import` already done:
 *
 * ```ts
 * mock.module('@tanstack/react-router', await routerWithLinkStub({ useParams: () => params }));
 * ```
 *
 * The spread is the point. Bun links a mocked module's whole namespace at
 * import, so a factory returning fewer names than the real module exports is a
 * hard `SyntaxError: Export named 'x' not found` in whichever consumer reaches
 * for a missing one — surfaced as an unhandled error between tests, naming
 * neither the mock nor the consumer. A file that stubs only `Link` passes right
 * up until someone adds a `useNavigate` to the component under test. Written
 * once here, the next copy cannot forget it.
 */
export async function routerWithLinkStub(
  overrides: Record<string, unknown> = {}
): Promise<() => Record<string, unknown>> {
  const actual = await import('@tanstack/react-router');
  return () => ({ ...actual, Link: LinkStub, ...overrides });
}
