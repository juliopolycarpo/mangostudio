/**
 * The API's only TOML boundary. Every parse and serialize in `apps/api` goes
 * through this module, so the underlying library can change in one place.
 */
import { readUtf8FileOrNull } from './safe-file';
import {
  markTomlOffsets,
  prepareTomlOffsets,
  rememberTomlOffsets,
  restoreTomlOffsets,
} from './toml-offsets';

export type TomlStringSections = Record<string, Record<string, string>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
    if (!isRecord(sectionValue)) {
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
 * Keep parser diagnostics while withholding quoted source values from errors and causes.
 * Native diagnostics can embed an unquoted secret or a duplicate private key.
 * Only punctuation in known expected-shape diagnostics is retained verbatim.
 *
 * @example
 * safeTomlParserError(new SyntaxError('TOML Parse error: Strings must be quoted: "secret"'));
 */
function safeTomlParserError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  let safeMessage = message;
  const describesShape =
    /^TOML Parse error: (?:Expected |Invalid (?:date|time|date-time offset): expected )/.test(
      message
    );
  for (let index = 0; index < message.length; index++) {
    if (message[index] !== '"' && message[index] !== "'") continue;
    const punctuation = describesShape && message.slice(index).match(/^'[[\]{}=,:.-]+'/);
    if (punctuation) {
      index += punctuation[0].length - 1;
      continue;
    }
    safeMessage = `${message.slice(0, index)}<source value omitted>`;
    break;
  }
  const ParserError =
    error instanceof SyntaxError ? SyntaxError : error instanceof RangeError ? RangeError : Error;
  return new ParserError(safeMessage);
}

/**
 * Parse a complete TOML document without reading from disk. Throws on
 * malformed TOML. Date/time values stay as Bun's Temporal types, so writing
 * an unrelated setting preserves local date/time forms and fractional precision.
 * Retain offset literals by matching a marked native parse to the original shape.
 * Diagnostics withhold source values so config logs and API callers cannot expose secrets.
 *
 * @example
 * const doc = parseTomlDocument('[auth]\nsecret = "s"');
 */
export function parseTomlDocument(content: string): Record<string, unknown> {
  try {
    const parsed = Bun.TOML.parse(content);
    const marked = markTomlOffsets(content);
    if (marked.zones.size > 0) {
      rememberTomlOffsets(parsed, Bun.TOML.parse(marked.content), marked.zones);
    }
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    throw safeTomlParserError(error);
  }
}

/**
 * Serialize a document to TOML text, the write half of a read-modify-write.
 *
 * @example
 * const toml = stringifyTomlDocument({ auth: { secret: 's' } });
 */
export function stringifyTomlDocument(doc: Record<string, unknown>): string {
  const marked = prepareTomlOffsets(doc);
  const serialized = Bun.TOML.stringify(marked.document);
  if (serialized === undefined) {
    throw new TypeError(
      `Cannot stringify TOML document: received ${String(doc)}; expected a TOML table object.`
    );
  }
  return restoreTomlOffsets(serialized, marked.literals);
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
  const current = isRecord(doc[section]) ? { ...(doc[section] as Record<string, unknown>) } : {};
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
  if (!isRecord(current) || !(key in current)) return false;
  const next = { ...current };
  delete next[key];
  doc[section] = next;
  return true;
}
