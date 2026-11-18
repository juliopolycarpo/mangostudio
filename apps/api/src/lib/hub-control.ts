/**
 * The secret and wire names the CLI uses to ask a running hub to shut down.
 *
 * A signal cannot do that job everywhere: on Windows `process.kill(pid, 'SIGTERM')` is
 * `TerminateProcess`, so the hub's graceful stop never runs. The hub instead mints a random
 * control token at startup and writes it into the single-instance state file (`~/.mango/run/
 * server.json`, owner-only where the OS supports it). Whoever can read that file can already
 * kill the process, so presenting the token proves nothing more than the CLI is the same user.
 *
 * The token never leaves the machine: the hub route (`routes/hub-control.ts`) answers only a
 * direct loopback peer, and the CLI client (`cli/hub-shutdown-request.ts`) dials only loopback.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Header that carries the control token. */
export const HUB_CONTROL_TOKEN_HEADER = 'x-mangostudio-control-token';

/** Path of the shutdown request, under the `/api` prefix. */
export const HUB_SHUTDOWN_PATH = '/api/control/shutdown';

/** Random token, 256 bits, hex. // Usage: createHubControlToken() // → 64 hex characters */
export function createHubControlToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Whether `provided` equals `expected`. False when either is absent. Compares digests so the
 * comparison takes the same time whatever the lengths and whatever prefix matches.
 * // Usage: hubControlTokenMatches(request.headers.get(HUB_CONTROL_TOKEN_HEADER), token)
 */
export function hubControlTokenMatches(
  provided: string | null | undefined,
  expected: string | undefined
): boolean {
  if (!provided || !expected) return false;
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

let activeToken: string | undefined;

/**
 * Mint this process's control token and keep it for the route. Called once, where the hub writes
 * its state file, so the token the route accepts is always the one the file holds.
 * // Usage: const token = issueHubControlToken()
 */
export function issueHubControlToken(): string {
  activeToken = createHubControlToken();
  return activeToken;
}

/** The token the route accepts; `undefined` until one is issued (no state file, no shutdown request). */
export function currentHubControlToken(): string | undefined {
  return activeToken;
}

/** Test seam: forget the issued token. */
export function resetHubControlTokenForTest(): void {
  activeToken = undefined;
}
