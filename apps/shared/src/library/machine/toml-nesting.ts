/**
 * The deepest container a TOML metadata document may hold, the root table
 * being depth 0.
 *
 * `smol-toml` accepts dotted keys and table headers of any depth, while the
 * Rust runtime host's `toml` crate stops at 80 levels and would otherwise
 * recurse once per level. Both hosts narrow validity to this limit instead
 * (`crates/mangostudio-runtime/src/library/smol_toml.rs` mirrors it), so a
 * document either host accepts nests no deeper than any real config does.
 */
export const TOML_NESTING_LIMIT = 64;

/**
 * Whether no array or plain object inside `value` sits more than
 * {@link TOML_NESTING_LIMIT} levels below it. A `Date` (smol-toml's
 * `TomlDate`) is a scalar. Iterative, because `smol-toml` builds values
 * hundreds of thousands of levels deep from a long dotted key.
 *
 * @example
 * tomlNestingWithinLimit(parseToml('a.b.c = 1')); // true: `a` and `b` are depths 1 and 2
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
  return typeof value === 'object' && value !== null && !(value instanceof Date);
}
