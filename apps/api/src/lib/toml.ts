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
 */
export function readTomlStringSections(filePath: string): TomlStringSections {
  const content = readUtf8FileOrNull(filePath);
  return content === null ? {} : parseTomlStringSections(content);
}
