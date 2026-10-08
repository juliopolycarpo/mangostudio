/**
 * Retain only lexical offsets; Bun owns TOML validation and table/array structure.
 * A document with offset datetimes needs a second native parse with marked values.
 * Pairwise traversal annotates the original immutable Instants, so equal instants
 * with different written offsets keep separate metadata. Native stringify writes
 * a marked copy and generated value markers are restored in one text pass.
 *
 * Metadata follows scalar identity: copying a table/array preserves it; replacing
 * an Instant or converting it through JSON uses the native serializer's default.
 * No comments or source layout are retained, matching the previous serializer.
 */
const offsetLiterals = new WeakMap<object, string>();
const MARKER_PREFIX = '__mango_toml_datetime_';
const OFFSET_DATETIME =
  /\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})/y;

/**
 * Mark offset literals outside comments and strings in an already validated document.
 * Native parsing of the marked copy supplies their exact structural locations.
 *
 * @example
 * markTomlOffsets('when = 1979-05-27T00:32-07:00').zones.size; // 1
 */
export function markTomlOffsets(content: string): {
  content: string;
  zones: Map<string, string>;
} {
  let prefix = MARKER_PREFIX;
  while (content.includes(prefix)) prefix += '_';
  const zones = new Map<string, string>();
  const parts: string[] = [];
  let copied = 0;
  let index = 0;
  while (index < content.length) {
    const character = content[index];
    if (character === '"' || character === "'") {
      index = skipString(content, index);
      continue;
    }
    if (character === '#') {
      const newline = content.indexOf('\n', index);
      index = newline < 0 ? content.length : newline + 1;
      continue;
    }
    OFFSET_DATETIME.lastIndex = index;
    const match = /\d/.test(character ?? '') ? OFFSET_DATETIME.exec(content) : null;
    if (!match) {
      index++;
      continue;
    }
    const marker = `${prefix}${zones.size}`;
    zones.set(marker, match[1]);
    parts.push(content.slice(copied, index), JSON.stringify(marker));
    index += match[0].length;
    copied = index;
  }
  parts.push(content.slice(copied));
  return { content: parts.join(''), zones };
}

/**
 * Skip a validated basic/literal string, including escapes and multiline delimiter runs.
 *
 * @example
 * skipString('"date-like text" next', 0); // 16
 */
function skipString(content: string, start: number): number {
  const quote = content[start];
  const multiline = content.startsWith(quote.repeat(3), start);
  let index = start + (multiline ? 3 : 1);
  while (index < content.length) {
    if (quote === '"' && content[index] === '\\') {
      index += 2;
      continue;
    }
    if (content[index] !== quote) {
      index++;
      continue;
    }
    if (!multiline) return index + 1;
    const firstQuote = index;
    while (content[index] === quote) index++;
    if (index - firstQuote >= 3) return index;
  }
  throw new TypeError('Cannot retain TOML offsets: unterminated string; expected validated TOML.');
}

/**
 * Associate each marked native value with its original Instant at the same table/array path.
 * Equal instants in different fields never share an offset by traversal order.
 *
 * @example
 * rememberTomlOffsets(original, markedDocument, markers.zones);
 */
export function rememberTomlOffsets(
  original: unknown,
  marked: unknown,
  zones: ReadonlyMap<string, string>
): void {
  if (typeof marked === 'string' && zones.has(marked)) {
    if (typeof original === 'string') return;
    const tag = Object.prototype.toString.call(original);
    if (tag !== '[object Temporal.Instant]') {
      throw new TypeError(
        `Cannot retain TOML offset for ${tag}; expected a native Temporal.Instant.`
      );
    }
    const instant = original as {
      toZonedDateTimeISO(zone: string): { toPlainDateTime(): { toString(): string } };
    };
    const zone = zones.get(marked) as string;
    const local = instant.toZonedDateTimeISO(/[Zz]/.test(zone) ? '+00:00' : zone);
    const timestamp = local
      .toPlainDateTime()
      .toString()
      .replace(/(?:\.(\d+))?$/, (_, fraction) => `.${(fraction ?? '').padEnd(3, '0')}`);
    offsetLiterals.set(original as object, `${timestamp}${zone.toUpperCase()}`);
    return;
  }
  if (!isContainer(original) || !isContainer(marked)) return;
  for (const [key, value] of Object.entries(marked)) {
    rememberTomlOffsets((original as Record<string, unknown>)[key], value, zones);
  }
}

/**
 * Return a retained offset literal for display; other values keep their existing formatter.
 *
 * @example
 * tomlOffsetLiteral(parseTomlDocument('when = 1979-05-27T00:32-07:00').when);
 */
export function tomlOffsetLiteral(value: unknown): string | undefined {
  return typeof value === 'object' && value !== null ? offsetLiterals.get(value) : undefined;
}

/**
 * Protect offset literals with collision-free strings while native stringify writes structure.
 * Preserve scalar identity in the input and preserve cycles for native rejection.
 *
 * @example
 * const marked = prepareTomlOffsets(document);
 */
export function prepareTomlOffsets(document: unknown): {
  document: unknown;
  literals: Map<string, string>;
} {
  const strings: string[] = [];
  const visited = new Set<object>();
  let hasOffsets = false;
  const pending = [document];
  while (pending.length > 0) {
    const value = pending.pop();
    if (tomlOffsetLiteral(value) !== undefined) hasOffsets = true;
    if (typeof value === 'string') strings.push(value);
    if (!isContainer(value) || visited.has(value)) continue;
    visited.add(value);
    for (const [key, item] of Object.entries(value)) {
      strings.push(key);
      pending.push(item);
    }
  }
  const literals = new Map<string, string>();
  if (!hasOffsets) return { document, literals };
  let prefix = MARKER_PREFIX;
  while (strings.some((value) => value.includes(prefix))) prefix += '_';
  return { document: replaceOffsets(document, prefix, literals, new WeakMap()), literals };
}

/**
 * Copy only containers, replacing retained Instants without mutating the caller's document.
 *
 * @example
 * replaceOffsets(document, '__mango_toml_datetime_', literals, new WeakMap());
 */
function replaceOffsets(
  value: unknown,
  prefix: string,
  literals: Map<string, string>,
  visited: WeakMap<object, unknown>
): unknown {
  const literal = tomlOffsetLiteral(value);
  if (literal !== undefined) {
    const marker = `${prefix}${literals.size}`;
    literals.set(marker, literal);
    return marker;
  }
  if (!isContainer(value)) return value;
  if (visited.has(value)) return visited.get(value);
  const copy = Array.isArray(value)
    ? new Array(value.length)
    : Object.create(Object.getPrototypeOf(value));
  visited.set(value, copy);
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(copy, key, {
      value: replaceOffsets(item, prefix, literals, visited),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return copy;
}

/**
 * Restore generated marker values with validated timestamp literals in one linear text pass.
 *
 * @example
 * restoreTomlOffsets(serialized, marked.literals);
 */
export function restoreTomlOffsets(content: string, literals: ReadonlyMap<string, string>): string {
  if (literals.size === 0) return content;
  return content.replace(
    /"(__mango_toml_datetime_+\d+)"/g,
    (match, marker) => literals.get(marker) ?? match
  );
}

/**
 * Recognize traversable containers while leaving native Date/Temporal scalars untouched.
 *
 * @example
 * isContainer({ when: 'today' }); // true
 */
function isContainer(value: unknown): value is object {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Date) &&
    !Object.prototype.toString.call(value).startsWith('[object Temporal.')
  );
}
