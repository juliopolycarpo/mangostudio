/**
 * Polls until `kill(pid, 0)` fails, or the budget runs out.
 *
 * Signalling a group and reaping it are not the same instant, so a termination
 * test has to wait rather than assert on the first look. `kill(pid, 0)` still
 * succeeds on a zombie, which is what makes this also a check that the group
 * leader lived long enough to waitpid its children.
 *
 * // Usage: expect(await waitUntilGone(descendantPid, 10_000)).toBe(true)
 */
export async function waitUntilGone(pid: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(20);
  }
  return false;
}
