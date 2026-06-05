/**
 * Compile-time type-equality assertions for tests.
 *
 * `Equals<A, B>` resolves to `true` only when `A` and `B` are mutually
 * assignable in both directions; `assertType<T>()` then fails `bun run check`
 * (tsgo) whenever the supplied condition is not exactly `true`. Pairing them
 * pins a derived type to its expected shape without any runtime cost.
 *
 * Usage:
 *   assertType<Equals<Static<typeof FooSchema>, Foo>>();
 */
export type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

export function assertType<_T extends true>(): void {
  // Compile-time only: the type parameter constraint does the work.
}
