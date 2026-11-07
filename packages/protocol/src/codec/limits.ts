/** Option validation shared by the codecs, the session and the transports. */

/**
 * Reads one integer option: the value when it is an integer at or above the
 * floor the spec allows and at or below an optional maximum; the fallback
 * when it is undefined. Malformed runtime values are refused.
 *
 * Not "byte ceiling" — the same rule governs counts (`maxInFlight`,
 * `maxStreamKeys`) as governs sizes, and one message shape covers both.
 *
 * @example
 * resolveIntegerAtLeast('maxFrameBytes', undefined, 16777216, 4096); // 16777216
 */
export function resolveIntegerAtLeast(
  name: string,
  value: number | undefined,
  fallback: number,
  floor: number,
  maximum?: number
): number {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isInteger(resolved) || resolved < floor) {
    const kind = typeof resolved;
    const received =
      (kind === 'object' && resolved !== null) || kind === 'function' ? kind : String(resolved);
    throw new RangeError(`${name} is ${received}; expected an integer of at least ${floor}`);
  }
  if (maximum !== undefined && resolved > maximum) {
    throw new RangeError(`${name} is ${resolved}; expected an integer of at most ${maximum}`);
  }
  return resolved;
}
