/**
 * The API's only TOML boundary. Every parse and serialize in `apps/api` goes
 * through this module, so the underlying library can change in one place.
 */
import { isTomlTable } from '@mangostudio/shared/library/machine';

import { readUtf8FileOrNull } from './safe-file';

export type TomlStringSections = Record<string, Record<string, string>>;

/**
 * The one error this module throws for a document that does not parse. The
 * message is fixed and carries nothing from the parser or the source, so what
 * the API exposes never depends on how Bun words a diagnostic. Bun reports no
 * TOML position (its `line` and `column` point into the calling script), so the
 * error has none either.
 *
 * @example
 * throw new TomlParseError();
 */
export class TomlParseError extends Error {
  constructor() {
    super('Invalid TOML document.');
    this.name = 'TomlParseError';
  }
}

/**
 * Project the string-valued entries of a parsed TOML document into sections.
 *
 * @example
 * const sections = parseTomlStringSections('[auth]\nsecret = "s"');
 */
export function parseTomlStringSections(content: string): TomlStringSections {
  return projectTomlStringSections(parseTomlDocument(content));
}

/**
 * Select string entries without changing the complete document's value types.
 *
 * @example
 * projectTomlStringSections({ auth: { secret: 's', retries: 2 } });
 */
function projectTomlStringSections(parsed: Record<string, unknown>): TomlStringSections {
  const sections: TomlStringSections = {};

  for (const [sectionName, sectionValue] of Object.entries(parsed)) {
    if (!isTomlTable(sectionValue)) {
      continue;
    }

    const stringEntries: Record<string, string> = {};
    for (const [entryName, entryValue] of Object.entries(sectionValue)) {
      if (typeof entryValue === 'string') {
        stringEntries[entryName] = entryValue;
      }
    }

    sections[sectionName] = stringEntries;
  }

  return sections;
}

/**
 * Read TOML string sections from a file, treating a missing file as empty.
 * Reads once and handles `ENOENT` directly rather than probing with `existsSync`.
 *
 * Lossy by design: only string-valued entries survive. Use {@link readTomlDocument}
 * for read-modify-write so non-string config (ports, booleans, tables) is preserved.
 *
 * @example
 * const secrets = readTomlStringSections(configPath);
 */
export function readTomlStringSections(filePath: string): TomlStringSections {
  return projectTomlStringSections(readTomlDocument(filePath));
}

/**
 * Read a full TOML document, preserving every value type, with a missing file
 * treated as an empty document.
 *
 * @example
 * const doc = readTomlDocument(configPath);
 */
export function readTomlDocument(filePath: string): Record<string, unknown> {
  const content = readUtf8FileOrNull(filePath);
  if (content === null) return {};
  try {
    return parseTomlDocument(content);
  } catch (error) {
    const parserError = error as Error;
    throw new Error(
      `Cannot parse TOML file ${JSON.stringify(filePath)}: ${JSON.stringify(parserError.message)}`,
      {
        cause: parserError,
      }
    );
  }
}

/**
 * Parse a complete TOML document without reading from disk. Throws a
 * {@link TomlParseError} on malformed TOML. Date/time values stay as Bun's
 * Temporal types, so writing an unrelated setting preserves local date/time
 * forms and fractional precision. Offset datetimes normalize to UTC while
 * preserving their exact instant. The error never carries Bun's diagnostic:
 * native text can embed an unquoted secret or a duplicate private key, and
 * filtering it would tie redaction to the parser's wording.
 *
 * @example
 * const doc = parseTomlDocument('[auth]\nsecret = "s"');
 */
export function parseTomlDocument(content: string): Record<string, unknown> {
  try {
    const parsed = Bun.TOML.parse(content);
    return isTomlTable(parsed) ? parsed : {};
  } catch {
    // Deliberately drops the parser's error, cause included.
    throw new TomlParseError();
  }
}

/**
 * Serialize a document to TOML text, the write half of a read-modify-write.
 *
 * @example
 * const toml = stringifyTomlDocument({ auth: { secret: 's' } });
 */
export function stringifyTomlDocument(doc: Record<string, unknown>): string {
  const serialized = Bun.TOML.stringify(doc);
  if (serialized === undefined) {
    throw new TypeError(
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- The existing conversion accepts URL or arbitrary input and preserves its diagnostic representation.
      `Cannot stringify TOML document: received ${String(doc)}; expected a TOML table object.`
    );
  }
  return serialized;
}

/**
 * Set `key` in `section` of `doc`, preserving the rest of the document.
 * Mutates `doc` in place so a read-modify-write keeps unrelated config intact.
 *
 * @example
 * setTomlSectionValue(doc, 'machine', 'installs_enabled', true);
 */
export function setTomlSectionValue(
  doc: Record<string, unknown>,
  section: string,
  key: string,
  value: string | boolean
): void {
  const existing = doc[section];
  const current = isTomlTable(existing) ? { ...existing } : {};
  current[key] = value;
  doc[section] = current;
}

/**
 * Delete `key` from `section` of `doc`, returning whether it was present.
 * A `false` result lets callers skip an otherwise no-op write.
 *
 * @example
 * deleteTomlSectionValue(doc, 'gemini_api_keys', 'old-key');
 */
export function deleteTomlSectionValue(
  doc: Record<string, unknown>,
  section: string,
  key: string
): boolean {
  const current = doc[section];
  // Own keys only: `in` also matches names inherited from Object.prototype, such as toString.
  if (!isTomlTable(current) || !Object.hasOwn(current, key)) return false;
  const next = { ...current };
  delete next[key];
  doc[section] = next;
  return true;
}
