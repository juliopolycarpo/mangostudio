// A compiled binary is exactly where module-resolution failures surface: the
// bundler decides at build time what is reachable, and a miss only shows up as
// a runtime error inside the shipped executable. The smoke greps for the shapes
// Bun emits so a binary that starts but cannot resolve its own chunks fails the
// smoke instead of shipping.
//
// Kept as a pure predicate — the smoke script owns the `fail()` — so the
// patterns can be asserted in a unit test.

/** Substrings that mean a bundled module failed to resolve at runtime. */
const MODULE_RESOLUTION_FAILURE_PATTERNS = [
  'ResolveMessage',
  'Cannot find module',
  './642.js',
] as const;

/**
 * Returns the first module-resolution failure pattern present in `text`, or
 * `null` when there is none.
 *
 * @example
 * findModuleResolutionFailure('error: Cannot find module "./642.js"');
 * // → 'Cannot find module'
 */
export function findModuleResolutionFailure(text: string): string | null {
  for (const pattern of MODULE_RESOLUTION_FAILURE_PATTERNS) {
    if (text.includes(pattern)) return pattern;
  }
  return null;
}
