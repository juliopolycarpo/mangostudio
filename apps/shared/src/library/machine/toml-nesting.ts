/**
 * The deepest container a TOML metadata document may hold, the root table
 * being depth 0.
 *
 * TOML parsers accept deeply nested dotted keys and table headers, while the
 * Rust runtime host's `toml` crate stops at 80 levels and would otherwise
 * recurse once per level. Both hosts narrow validity to this limit instead
 * (`crates/mangostudio-runtime/src/library/toml_document.rs` mirrors it), so a
 * document either host accepts nests no deeper than any real config does.
 */
export const TOML_NESTING_LIMIT = 64;

/**
 * Whether no array or plain object inside `value` sits more than
 * {@link TOML_NESTING_LIMIT} levels below it. Dates and Bun's Temporal values
 * are scalars, since neither is a plain table. The walk is iterative so a long
 * dotted key cannot exhaust the call stack.
 *
 * @example
 * tomlNestingWithinLimit({ a: { b: { c: 1 } } }); // true: `a` and `b` are depths 1 and 2
 */
export function tomlNestingWithinLimit(value: unknown): boolean {
  const pending: { readonly value: unknown; readonly depth: number }[] = [{ value, depth: 0 }];
  for (let next = pending.pop(); next; next = pending.pop()) {
    const children = containerChildren(next.value);
    if (children.length === 0) continue;
    if (next.depth >= TOML_NESTING_LIMIT) return false;
    for (const child of children) pending.push({ value: child, depth: next.depth + 1 });
  }
  return true;
}

/** The child values of an array or plain object that are themselves containers. */
function containerChildren(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.filter(isContainer);
  if (!isContainer(value)) return [];
  return Object.values(value).filter(isContainer);
}

function isContainer(value: unknown): value is object {
  return Array.isArray(value) || isTomlTable(value);
}

/**
 * Whether `value` is a TOML table: a plain object or a null-prototype object.
 * Arrays, `Date` and the Temporal values `Bun.TOML` returns for date/time
 * literals are scalars or arrays, never tables. Checking the prototype rather
 * than naming those types means a value type Bun adds later is rejected too.
 *
 * @example
 * isTomlTable({ a: 1 }); // true
 * isTomlTable(Reflect.get(Bun.TOML.parse('d = 1979-05-27'), 'd')); // false
 */
export function isTomlTable(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
