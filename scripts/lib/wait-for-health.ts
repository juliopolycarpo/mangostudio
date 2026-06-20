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
 */
export function resolveReadyBudgetMs(): number {
  return process.platform === 'win32' ? WIN32_READY_BUDGET_MS : DEFAULT_READY_BUDGET_MS;
}

/**
 * Poll `url` until it responds with any 2xx status, the request errors, or
 * the configured budget is exhausted. Connection-level failures (refused,
 * reset) are treated as "not ready yet" and retried; the timeout path throws
 * with the URL and elapsed budget so the caller can surface a useful message.
 */
export async function waitForServerReady(
  url: string,
  options: WaitForServerReadyOptions = {}
): Promise<void> {
  const budgetMs = options.budgetMs ?? resolveReadyBudgetMs();
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  const deadline = Date.now() + budgetMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Connection refused / reset / EAI_AGAIN — server is not ready yet.
    }
    await Bun.sleep(intervalMs);
  }

  throw new Error(`Server never became ready at ${url} within ${budgetMs}ms`);
}
