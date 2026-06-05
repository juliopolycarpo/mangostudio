/**
 * Test-only helpers shared across workspace test suites.
 * Keep any third-party imports used by this public test surface declared in this workspace.
 */
export * from './mock-data';

/**
 * Wait for async test state to settle.
 * // Usage: await sleep(50)
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
