import { parse as parseToml } from 'smol-toml';
import { readUtf8FileOrNull } from './safe-file';

export type TomlStringSections = Record<string, Record<string, string>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Project the string-valued entries of a parsed TOML document into sections. */
export function parseTomlStringSections(content: string): TomlStringSections {
  const parsed = parseToml(content);
  if (!isRecord(parsed)) {
    return {};
  }

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
 */
export function readTomlStringSections(filePath: string): TomlStringSections {
  const content = readUtf8FileOrNull(filePath);
  return content === null ? {} : parseTomlStringSections(content);
}

/**
 * Read a full TOML document, preserving every value type, with a missing file
 * treated as an empty document. // Usage: const doc = readTomlDocument(configPath);
 */
export function readTomlDocument(filePath: string): Record<string, unknown> {
  const content = readUtf8FileOrNull(filePath);
  if (content === null) return {};
  return parseTomlDocument(content);
}

/** Parse a complete TOML document without reading from disk. */
export function parseTomlDocument(content: string): Record<string, unknown> {
  const parsed = parseToml(content);
  return isRecord(parsed) ? parsed : {};
}

/** Shared by every `setTomlSection*` writer: replace one key, keep the rest of the section. */
function setTomlSectionEntry(
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
 * Set a string `key` in `section` of `doc`, preserving the rest of the document.
 * Mutates `doc` in place so a read-modify-write keeps unrelated config intact.
 */
export function setTomlSectionValue(
  doc: Record<string, unknown>,
  section: string,
  key: string,
  value: string
): void {
  setTomlSectionEntry(doc, section, key, value);
}

/** The boolean counterpart of {@link setTomlSectionValue}, for flags like `installs_enabled`. */
export function setTomlSectionBoolean(
  doc: Record<string, unknown>,
  section: string,
  key: string,
  value: boolean
): void {
  setTomlSectionEntry(doc, section, key, value);
}

/**
 * Delete `key` from `section` of `doc`, returning whether it was present.
 * A `false` result lets callers skip an otherwise no-op write.
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
