/** Option validation shared by the codecs, the session and the transports. */

/**
 * Reads one integer option: the value when it is an integer at or above the
 * floor the spec allows, the fallback when it is absent.
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
  floor: number
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < floor) {
    throw new RangeError(`${name} is ${resolved}; expected an integer of at least ${floor}`);
  }
  return resolved;
}
