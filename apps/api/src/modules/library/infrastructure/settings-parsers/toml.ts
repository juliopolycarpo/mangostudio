import { parseTomlDocument } from '../../../../lib/toml';
import {
  redactSettingsDocument,
  type SettingsRedactionOptions,
} from '../../domain/settings-redaction';
import type { SettingsParserResult } from './types';

export function parseTomlSettings(
  content: string,
  options: SettingsRedactionOptions
): SettingsParserResult {
  try {
    const document = collapseProjects(parseTomlDocument(content));
    return {
      parsed: true,
      fields: redactSettingsDocument(document, options),
    };
  } catch {
    return {
      parsed: false,
      failureReason: 'invalid-toml',
      fields: [],
    };
  }
}

function collapseProjects(document: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(document.projects)) return document;
  return {
    ...document,
    projects: {
      count: Object.keys(document.projects).length,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
