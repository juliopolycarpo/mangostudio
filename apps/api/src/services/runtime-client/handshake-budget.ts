/**
 * How long the hub waits for a runtime to say hello, per transport.
 *
 * A handshake budget bounds one thing: the time from the hub starting a child
 * (or dialing a socket) to the runtime's `hello`. It is not a provisioning
 * budget — an image pull, a release download and a WSL install each run under
 * their own timeout and finish before this clock starts — and it is not a
 * liveness budget: once the session is up, the protocol's ping/pong decides
 * whether the peer is still there. The clock starts once the launcher has
 * returned a process, so what a Windows spawn pays for a never-seen binary
 * (~1.8s measured, inside the synchronous spawn call) is not in it either.
 * It stays a wall clock because the runtime shows no sign of life before its
 * `hello` — no frame, no stderr — to key a shorter one off; the measurements
 * are under "Runtime startup budgets" in `docs/reference/tooling.md`.
 *
 * The local default was measured on Linux and macOS, where a process spawn and
 * a first request are both cheap. A Windows hub pays for neither: process spawn
 * plus first-run disk warmup costs multiples of what the other platforms pay,
 * and a *healthy* runtime has been observed handshaking in 6288ms — once above
 * 10000ms. At 5s that is an environment reporting itself unavailable while
 * nothing is wrong with it, which is issue #1041.
 *
 * `stdio` and `wsl` read the local budget by passing no timeout. `wsl` needs no
 * number of its own: provisioning executes the freshly installed binary
 * (`--version`) before it returns, so the first run of a new binary is paid
 * outside this window. See {@link resolveRemoteHandshakeTimeoutMs} for the
 * transports that reach another machine.
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
 * Picks the handshake budget for a child on the hub's own machine.
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

/** The transports whose handshake crosses to another machine. */
export type RemoteHandshakeTransport = 'ssh' | 'container' | 'http';

/**
 * What each remote transport needs beyond a local spawn, flat on every platform
 * because the link, the engine and the far machine dominate it:
 *
 * - `ssh`: a connection setup, a key exchange, and a process start on the far
 *   machine all happen before the first frame, and a busy host on a slow link
 *   uses all of it.
 * - `container`: the engine creates the container, starts an init, and runs a
 *   binary off a bind mount. The image is already on disk — the pull is its own
 *   step — so this budgets a start, not a download.
 * - `http`: a WebSocket dial to a runtime that is already listening, then the
 *   hello exchange. Nothing is spawned, which is why it is the smallest; the
 *   same number bounds the dial and the handshake that follows it.
 */
const REMOTE_HANDSHAKE_TIMEOUT_MS: Readonly<Record<RemoteHandshakeTransport, number>> = {
  ssh: 20_000,
  container: 20_000,
  http: 15_000,
};

/**
 * Picks the handshake budget for a transport that reaches another machine.
 *
 * Its flat number, floored at the local budget for the same platform: `ssh`
 * and `container` spawn `ssh.exe` and `docker.exe` on the hub and then do
 * strictly more than a local child, and `http` crosses a network, so none may
 * be given less time than a bare local spawn (#1054). The floor only moves a
 * number where the hub has already admitted the machine is slow — on a Windows
 * hub all three become 30s; everywhere else they are unchanged. A platform
 * multiplier would be tuning the wrong term.
 *
 * @example
 * handshakeTimeoutMs: resolveRemoteHandshakeTimeoutMs('ssh'),
 */
export function resolveRemoteHandshakeTimeoutMs(
  transport: RemoteHandshakeTransport,
  platform: NodeJS.Platform = process.platform
): number {
  return Math.max(REMOTE_HANDSHAKE_TIMEOUT_MS[transport], resolveHandshakeTimeoutMs(platform));
}
