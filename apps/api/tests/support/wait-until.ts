/**
 * Polls `condition` until it holds, failing with what was expected.
 *
 * @example
 * await waitUntil(() => existsSync(marker), 'the marker');
 */
export async function waitUntil(
  condition: () => boolean,
  what: string,
  timeoutMs = 10_000,
  context?: () => string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      const detail = context ? `; ${context()}` : '';
      throw new Error(`expected ${what} | received: nothing within ${timeoutMs}ms${detail}`);
    }
    await Bun.sleep(20);
  }
}
