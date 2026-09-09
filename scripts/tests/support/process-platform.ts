/**
 * Swaps `process.platform` for the duration of a test and hands back the undo.
 *
 * Shared because two suites need it — the readiness budget and the handshake
 * budget both branch on the host — and a second copy is a second place to fix
 * when one of them learns something about restoring a global.
 *
 * Restores the captured descriptor rather than re-defining from the value, so a
 * host that ships `process.platform` as an accessor or as read-only comes back
 * exactly as it was rather than as a plain writable data property.
 *
 * @example
 * const restore = stubProcessPlatform('win32');
 * try {
 *   expect(resolveReadyBudgetMs()).toBe(WIN32_READY_BUDGET_MS);
 * } finally {
 *   restore();
 * }
 */
export function stubProcessPlatform(platform: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  return () => {
    if (original) {
      Object.defineProperty(process, 'platform', original);
      return;
    }
    // Nothing owned it before us — leaving our stub behind would be worse than
    // deleting it and letting the prototype answer again.
    Reflect.deleteProperty(process, 'platform');
  };
}
