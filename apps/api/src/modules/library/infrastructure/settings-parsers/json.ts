import {
  redactSettingsDocument,
  type SettingsRedactionOptions,
} from '../../domain/settings-redaction';
import type { SettingsParserResult } from './types';

export interface JsonSettingsParserOptions extends SettingsRedactionOptions {
  readonly section?: string;
}

export function parseJsonSettings(
  content: string,
  options: JsonSettingsParserOptions
): SettingsParserResult {
  try {
    const document: unknown = JSON.parse(content);
    const selected =
      options.section && isRecord(document) ? (document[options.section] ?? {}) : document;
    return {
      parsed: true,
      fields: redactSettingsDocument(selected, {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
