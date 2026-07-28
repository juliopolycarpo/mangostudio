import {
  redactSettingsDocument,
  type SettingsRedactionOptions,
} from '../../domain/settings-redaction';
import type { SettingsParserResult } from './types';

export interface JsonSettingsParserOptions extends SettingsRedactionOptions {
  /** Project only this top-level key, rooted at it. */
  readonly section?: string;
  /** Drop these top-level keys, so a section owned by another source is not reported twice. */
  readonly excludeSections?: readonly string[];
}

export function parseJsonSettings(
  content: string,
  options: JsonSettingsParserOptions
): SettingsParserResult {
  try {
    const document: unknown = JSON.parse(content);
    return {
      parsed: true,
      fields: redactSettingsDocument(selectSection(document, options), {
        ...options,
        rootPath: options.section,
      }),
    };
  } catch {
    return {
      parsed: false,
      failureReason: 'invalid-json',
      fields: [],
    };
  }
}

/**
 * A non-object document has no sections at all, so it must project to nothing
 * rather than fall through as the section's contents under the section's path.
 */
function selectSection(document: unknown, options: JsonSettingsParserOptions): unknown {
  if (options.section !== undefined) {
    return isRecord(document) ? (document[options.section] ?? {}) : {};
  }
  if (!options.excludeSections?.length || !isRecord(document)) return document;
  const excluded = new Set(options.excludeSections);
  return Object.fromEntries(Object.entries(document).filter(([key]) => !excluded.has(key)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
