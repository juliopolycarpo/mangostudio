/**
 * How long the hub waits for a runtime child on its own machine to say hello.
 *
 * The default was measured on Linux and macOS, where a process spawn and a
 * first request are both cheap. A Windows hub pays for neither: process spawn
 * plus first-run JIT and disk warmup costs multiples of what the other
 * platforms pay, and a *healthy* runtime has been observed handshaking in
 * 6288ms — once above 10000ms. At 5s that is an environment reporting itself
 * unavailable while nothing is wrong with it, which is issue #1041.
 *
 * Only the transports whose child runs on the hub's own machine read this —
 * `stdio` and `wsl`, both of which inherit it by passing no timeout. The
 * transports that reach another machine state their own budget instead — not
 * because the hub's platform is irrelevant to them (the `ssh` and `docker`
 * wrappers are spawned on it) but because those budgets are dominated by network
 * and remote work, so a platform branch would be tuning the wrong term.
 *
 * Note what that costs on `win32`, because those flat numbers were chosen
 * against the 5s default and no longer clear the Windows one: `ssh` and
 * `container` are 20s and `http` 15s, all three now *below* what a plain local
 * child gets there. Judged acceptable rather than unnoticed — they are already
 * three to four times the default this branch left alone. If a healthy remote
 * runtime is ever measured losing to one of them on a Windows hub, the fix is a
 * platform floor on that budget, not a bigger flat number.
 *
 * Deliberately not shared with `scripts/lib/platform-budget.ts`, which has the
 * same shape for the same reason on the smoke side. Sharing is closed from both
 * ends rather than merely inconvenient: `apps/api` cannot import from
 * `scripts/`, and `platform-budget.ts` is reachable from `scripts/test-build.ts`
 * — a smoke entrypoint `scripts/tests/smoke-dependencies.unit.test.ts` holds to
 * zero external imports — so it cannot import `@mangostudio/shared` either. One
 * home for the predicate needs that rule to move first.
 */

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
/**
 * ~5x the worst completed Windows measurement, which also covers the run that
 * was killed above 10000ms without ever finishing. Not the 60s the CI smoke
 * chose: being wrong upwards there only costs a slower red, while here it
 * costs somebody watching a spinner.
 */
const WIN32_HANDSHAKE_TIMEOUT_MS = 30_000;

/**
 * Picks the handshake budget for the platform the child will start on.
 *
 * The platform is a parameter rather than a read of `process.platform` inside
 * the body, so both branches are reachable from a test without stubbing a
 * global. Every caller wants the hub's own platform, `wsl` included: its child
 * is a Linux binary, but the `wsl.exe` launch that starts it is paid on Windows.
 *
 * Typed as `NodeJS.Platform` rather than `string` so the one spelling that means
 * anything here has to be spelled right: `'windows'` or `'Win32'` would type-
 * check against `string` and silently take the 5s branch.
 *
 * @example
 * // in spawn-runtime-child.ts, for a child on this machine:
 * handshakeTimeoutMs: options.handshakeTimeoutMs ?? resolveHandshakeTimeoutMs(),
 */
export function resolveHandshakeTimeoutMs(platform: NodeJS.Platform = process.platform): number {
  return platform === 'win32' ? WIN32_HANDSHAKE_TIMEOUT_MS : DEFAULT_HANDSHAKE_TIMEOUT_MS;
}
