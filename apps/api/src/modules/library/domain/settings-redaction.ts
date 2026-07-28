import type { SettingsField } from '@mangostudio/shared/library';
import { looksCredentialShaped } from '../../../lib/credential-policy';

export interface SettingsRedactionOptions {
  readonly homeDir: string;
  readonly rootPath?: string;
}

export function redactSettingsDocument(
  document: unknown,
  options: SettingsRedactionOptions
): SettingsField[] {
  const fields: SettingsField[] = [];
  collectFields(document, options.rootPath ?? '', fields, options);
  return fields;
}

function collectFields(
  value: unknown,
  path: string,
  fields: SettingsField[],
  options: SettingsRedactionOptions,
  fieldName = ''
): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      collectFields(item, `${path}[${index}]`, fields, options, fieldName);
    }
    return;
  }

  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (shouldOmitSubtree(key)) continue;
      collectFields(item, path ? `${path}.${key}` : key, fields, options, key);
    }
    return;
  }

  const renderedValue = value instanceof Date ? value.toISOString() : String(value);
  if (isCredentialField(fieldName, renderedValue)) {
    fields.push({
      path: relativizeHome(path || '$', options.homeDir),
      presentation: 'redacted',
    });
    return;
  }

  fields.push({
    path: relativizeHome(path || '$', options.homeDir),
    presentation: 'value',
    value: relativizeHome(renderedValue, options.homeDir),
  });
}

function isCredentialField(name: string, value: string): boolean {
  const normalizedName = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  return (
    looksCredentialShaped(normalizedName, value) || /(?:^|[_-])key(?:$|[_-])/i.test(normalizedName)
  );
}

function relativizeHome(value: string, homeDir: string): string {
  if (!homeDir) return value;
  const escapedHome = homeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return value.replace(new RegExp(`${escapedHome}(?=$|[\\\\/])`, 'g'), '~');
}

function shouldOmitSubtree(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized === 'authinfo' ||
    normalized.endsWith('cache') ||
    normalized.startsWith('statsig') ||
    normalized === 'installation_id' ||
    normalized.startsWith('session') ||
    normalized === 'credentials'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}
