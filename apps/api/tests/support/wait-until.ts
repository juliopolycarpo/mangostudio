/**
 * Polls `condition` until it holds, failing with what was expected. The
 * condition may be async (a route read, a database query).
 *
 * The deadline is wall-clock, not a poll count: a count shrinks the budget
 * to nothing when each check is slow, which is exactly what a loaded host does.
 * It asserts liveness (the work happens), never speed, so keep it generous.
 *
 * @example
 * await waitUntil(() => existsSync(marker), 'the marker');
 * await waitUntil(async () => (await receipt(id)).state === 'completed', 'the receipt');
 */
export async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 10_000,
  context?: () => string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) {
      const detail = context ? `; ${context()}` : '';
      throw new Error(`expected ${what} | received: nothing within ${timeoutMs}ms${detail}`);
    }
    await Bun.sleep(20);
  }
}
