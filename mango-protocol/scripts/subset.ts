/**
 * Recursive subset match used by every corpus consumer: every member of
 * `expected` must equal the corresponding member of `actual`, extra members are
 * allowed, arrays must match in length and order.
 *
 * @example
 * isSubset({ type: 'ping' }, { type: 'ping', 'x-trace': 1 }); // true
 */
export function isSubset(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((item, index) => isSubset(item, actual[index]))
    );
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false;
    return Object.entries(expected).every(([key, value]) =>
      isSubset(value, (actual as Record<string, unknown>)[key])
    );
  }
  return Object.is(expected, actual);
}
