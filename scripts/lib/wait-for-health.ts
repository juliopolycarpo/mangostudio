// Shared readiness probe for the binary and Docker smoke scripts.
//
// Polls an HTTP endpoint until it reports 2xx or the configured budget is
// exhausted, then throws. Centralised here so the binary smoke
// (scripts/test-build.ts) can share one source of truth with the bash helper
// scripts/release/wait-for-health.sh. Keep the default budget in lockstep with
// that shell helper's 30 × 1s = 30s default so all readiness probes stay
// consistent; bump the Windows budget because process spawn + first-request
// JIT/disk warmup on Windows GitHub runners routinely blows past 7-8s
// (see issue #377: the previous 15 × 500ms = 7.5s budget was tight enough to
// flake the `Binary windows-x64` job on otherwise healthy cold starts).

import { pickPlatformBudgetMs } from './platform-budget';

/** Default readiness budget in milliseconds; matches wait-for-health.sh (30 × 1s). */
export const DEFAULT_READY_BUDGET_MS = 30_000;

/**
 * Windows-specific readiness budget. GitHub `windows-*` runners need noticeably
 * more headroom for process spawn + first-request warmup than Linux/macOS.
 */
export const WIN32_READY_BUDGET_MS = 60_000;

/** Delay between probes in milliseconds. */
export const POLL_INTERVAL_MS = 500;

export interface WaitForServerReadyOptions {
  /** Total time to wait before throwing. Overrides the platform default. */
  budgetMs?: number;
  /** Delay between probes. Overrides `POLL_INTERVAL_MS`. */
  intervalMs?: number;
}

/**
 * Resolve the platform-default readiness budget. Windows gets the longer
 * budget; everything else gets the shared default that matches the bash helper.
 * Exported separately from `waitForServerReady` so unit tests can pin the value
 * without spinning up an HTTP loop.
 * @example const budgetMs = resolveReadyBudgetMs();
 */
export function resolveReadyBudgetMs(): number {
  return pickPlatformBudgetMs(DEFAULT_READY_BUDGET_MS, WIN32_READY_BUDGET_MS);
}

/**
 * Poll `url` until it responds with any 2xx status or the configured budget
 * is exhausted. Connection-level failures (refused,
 * reset) are treated as "not ready yet" and retried; the timeout path throws
 * with the URL and elapsed budget so the caller can surface a useful message.
 * Requests, response bodies and poll intervals share the same deadline.
 * @example await waitForServerReady('http://127.0.0.1:3001/api/health', { budgetMs: 30_000 });
 */
export async function waitForServerReady(
  url: string,
  options: WaitForServerReadyOptions = {}
): Promise<void> {
  const budgetMs = options.budgetMs ?? resolveReadyBudgetMs();
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  const deadline = performance.now() + budgetMs;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), budgetMs);

  try {
    while (performance.now() < deadline) {
      if (await probeServerReady(url, controller.signal)) return;
      const remainingMs = Math.max(0, deadline - performance.now());
      await Bun.sleep(Math.min(intervalMs, remainingMs));
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }

  throw new Error(`Server never became ready at ${url} within ${budgetMs}ms`);
}

/** Check status without retaining a response body or an unbounded request. */
async function probeServerReady(url: string, signal: AbortSignal): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch {
    // Connection refused / reset / EAI_AGAIN — server is not ready yet.
    return false;
  }

  try {
    await response.body?.cancel();
  } catch {
    // An already-errored body must not override readiness from the headers.
  }
  return response.ok;
}
