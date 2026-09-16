/**
 * Whether the Rust half of the protocol lanes can run on this machine.
 *
 * The TypeScript half of `@mangostudio/protocol` and the `mango-protocol`
 * crate are one contract proved by two suites, but only CI is guaranteed to
 * carry a Rust toolchain. Every caller asks here first and degrades to the
 * TypeScript half with a warning rather than failing a contributor's machine.
 *
 * @example
 * if (hasCargo()) tasks.push(clippyTask());
 * else warnNoCargo();
 */

import { warn } from '../lib/log';

/** True when `cargo` resolves on PATH. */
export function hasCargo(): boolean {
  return Bun.which('cargo') !== null;
}

export function warnNoCargo(): void {
  warn('cargo not found on PATH; skipping the Rust half. CI runs it.');
}

/** True when `cargo-hack` resolves on PATH; CI installs it via `taiki-e/install-action`. */
export function hasCargoHack(): boolean {
  return Bun.which('cargo-hack') !== null;
}

export function warnNoCargoHack(): void {
  warn('cargo-hack not found on PATH; skipping the feature-powerset check. CI runs it.');
}
