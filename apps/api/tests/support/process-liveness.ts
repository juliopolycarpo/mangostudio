/** A signal-0 probe returns normally for a live PID and throws when the observation fails. */
export type ProcessLivenessProbe = (pid: number, signal: 0) => unknown;

/**
 * Proves PID absence only from an Error carrying ESRCH. Permission and unknown failures leave liveness unproven.
 *
 * @example
 * if (isProcessAbsent(child.pid)) return;
 */
export function isProcessAbsent(pid: number, probe: ProcessLivenessProbe = process.kill): boolean {
  try {
    probe(pid, 0);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (error instanceof Error && code === 'ESRCH') return true;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `process liveness pid ${pid}: expected a liveness observation or an Error carrying ESRCH | received: ${String(code ?? 'unknown code')}: ${detail}`,
      { cause: error }
    );
  }
}

/**
 * Whether `pid` is absent, polling for up to `timeoutMs`. Only ESRCH proves absence;
 * permission and unknown probe failures reject with context instead of certifying cleanup.
 *
 * @example
 * expect(await processGone(pid)).toBe(true);
 */
export async function processGone(
  pid: number,
  timeoutMs = 5_000,
  probe: ProcessLivenessProbe = process.kill
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (isProcessAbsent(pid, probe)) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(20);
  }
}
