/**
 * Teaches `bun:test`'s `expect` about the jest-dom matchers `bun.setup.ts`
 * registers at runtime.
 *
 * `@testing-library/jest-dom` ships declaration merging for jest and for
 * vitest, and neither reaches `bun:test` — so `expect(el).toBeInTheDocument()`
 * runs green and fails `tsc` with `TS2339: Property 'toBeInTheDocument' does
 * not exist on type 'Matchers<HTMLElement>'`. The runtime `expect.extend` and
 * this file have to move together.
 */

import type { expect } from 'bun:test';
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

declare module 'bun:test' {
  interface Matchers<T = unknown>
    extends TestingLibraryMatchers<typeof expect.stringContaining, T> {}
  interface AsymmetricMatchers extends TestingLibraryMatchers<unknown, unknown> {}
}
