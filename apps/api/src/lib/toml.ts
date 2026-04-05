import { existsSync, readFileSync } from 'fs';
import { parse as parseToml } from 'smol-toml';

export type TomlStringSections = Record<string, Record<string, string>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readTomlStringSections(filePath: string): TomlStringSections {
  if (!existsSync(filePath)) {
    return {};
  }

  const parsed = parseToml(readFileSync(filePath, 'utf8'));
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
