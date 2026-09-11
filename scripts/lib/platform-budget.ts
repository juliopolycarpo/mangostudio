// The one place a smoke helper says "Windows needs longer".
//
// Two budgets already branch on the host — the readiness poll in
// `wait-for-health.ts` and the runtime handshake in `runtime-handshake.ts` —
// for the same reason (issue #377: process spawn plus first-run JIT and disk
// warmup on a GitHub `windows-*` runner costs multiples of what Linux and macOS
// pay). The values differ per probe; the predicate does not, and a second copy
// of it is a second place to forget when a third probe needs the same headroom.
//
// Imports nothing: everything reachable from `scripts/test-build.ts` must stay
// on `node:`/`bun` builtins and other `scripts/lib` modules, which
// `scripts/tests/smoke-dependencies.unit.test.ts` enforces.

/**
 * Picks the budget for the current host: the Windows one on `win32`, the shared
 * default everywhere else.
 *
 * Kept as a function rather than a constant so a test can stub
 * `process.platform` and see both branches without re-importing the module.
 *
 * @example
 * export const resolveReadyBudgetMs = () =>
 *   pickPlatformBudgetMs(DEFAULT_READY_BUDGET_MS, WIN32_READY_BUDGET_MS);
 */
export function pickPlatformBudgetMs(defaultMs: number, win32Ms: number): number {
  return process.platform === 'win32' ? win32Ms : defaultMs;
}
