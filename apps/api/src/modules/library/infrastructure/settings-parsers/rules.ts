import {
  redactSettingsDocument,
  type SettingsRedactionOptions,
} from '../../domain/settings-redaction';
import type { SettingsParserResult } from './types';

export interface PermissionRulesSource {
  readonly name: string;
  readonly content: string;
}

const DECISION_PATTERN = /\bdecision\s*=\s*["']([^"']+)["']/;
/**
 * `decision` is matched independently of position, so `pattern` must be too:
 * requiring `decision` to follow it dropped `decision = …, pattern = …` rules
 * entirely and reported the target as having no rules at all. The value runs to
 * the next `key =`, or to a trailing call paren, or to the end of the line.
 */
const RULE_PATTERN = /\bpattern\s*=\s*(.+?)\s*(?:,\s*[A-Za-z_]\w*\s*=|\)\s*$|$)/;

export function parsePermissionRules(
  sources: readonly PermissionRulesSource[],
  options: SettingsRedactionOptions
): SettingsParserResult {
  const fields = sources.flatMap((source) => extractRules(source, options));
  return { parsed: true, fields };
}

function extractRules(
  source: PermissionRulesSource,
  options: SettingsRedactionOptions
): SettingsParserResult['fields'] {
  return source.content.split(/\r?\n/).flatMap((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return [];

    const decision = DECISION_PATTERN.exec(trimmed)?.[1];
    const pattern = RULE_PATTERN.exec(trimmed)?.[1];
    if (!decision || !pattern) return [];

    return redactSettingsDocument(
      { pattern: pattern.trim(), decision },
      {
        ...options,
        rootPath: `${source.name}[${index + 1}]`,
      }
    );
  });
}
