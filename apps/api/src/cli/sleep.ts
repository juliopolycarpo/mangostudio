/**
 * Promise-based delay used as the default poll backoff across CLI commands
 * (serve/stop/killserver). Kept in one place so timing behavior stays consistent.
 */

/** Resolve after `ms` milliseconds. // Usage: await sleep(100) */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
