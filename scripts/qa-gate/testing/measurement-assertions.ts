// Test-only assertion for explicit measurement states, so a wrong state fails
// with `expected state: X | received: Y (reasons)` rather than a bare
// "Expected partial, Received measured".

import type { DataState, Measurement } from '../model/states';

/**
 * Assert that a measurement is in the expected state and return it narrowed.
 * // Usage: const cell = expectState(await measureComponentLoc(files, read), 'partial');
 */
export const expectState = <S extends DataState, T>(
  cell: Measurement<T>,
  state: S
): Extract<Measurement<T>, { state: S }> => {
  if (cell.state !== state) {
    const reasons = 'reasons' in cell ? ` (${cell.reasons.join('; ')})` : '';
    throw new Error(`expected state: ${state} | received: ${cell.state}${reasons}`);
  }
  return cell as Extract<Measurement<T>, { state: S }>;
};
