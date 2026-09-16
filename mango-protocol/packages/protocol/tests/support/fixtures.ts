/**
 * Helpers the conformance suites share: the comparison rule of
 * scripts/verify-spec.ts and base64 decoding for the chunk corpus.
 */

/**
 * Recursive subset match: every member of `expected` equals the value's member,
 * so a decoder may keep unknown members the fixture does not list.
 *
 * @example
 * isSubset({ type: 'ping' }, { type: 'ping', 'x-at': 1 }); // true
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

/**
 * Decodes one base64 message of the chunk corpus. `atob` keeps the core
 * browser-safe; no `node:` module is involved.
 *
 * @example
 * fromBase64('AQAAAAAAAAAB'); // Uint8Array of the 9-byte header
 */
export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Encodes bytes as base64, so a re-encoded chunk can be compared with the
 * corpus as it is written.
 *
 * @example
 * toBase64(new Uint8Array([1, 0])); // 'AQA='
 */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
