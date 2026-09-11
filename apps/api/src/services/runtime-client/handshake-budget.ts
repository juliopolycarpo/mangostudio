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
 * wrappers are spawned on it) but because those budgets already sit at three to
 * four times this default and are dominated by network and remote work, so a
 * platform branch would be tuning the wrong term.
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
 * @example
 * // in spawn-runtime-child.ts, for a child on this machine:
 * handshakeTimeoutMs: options.handshakeTimeoutMs ?? resolveHandshakeTimeoutMs(),
 */
export function resolveHandshakeTimeoutMs(platform: string = process.platform): number {
  return platform === 'win32' ? WIN32_HANDSHAKE_TIMEOUT_MS : DEFAULT_HANDSHAKE_TIMEOUT_MS;
}
