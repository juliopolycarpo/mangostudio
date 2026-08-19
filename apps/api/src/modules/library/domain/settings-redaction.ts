import type { SettingsField } from '@mangostudio/shared/library';
import { looksCredentialShaped } from '../../../lib/credential-policy';

export interface SettingsRedactionOptions {
  readonly homeDir: string;
  readonly rootPath?: string;
}

/** Compiled once per document; recompiling it per leaf dominated the walk. */
type HomePattern = RegExp | null;

export function redactSettingsDocument(
  document: unknown,
  options: SettingsRedactionOptions
): SettingsField[] {
  const fields: SettingsField[] = [];
  collectFields(document, options.rootPath ?? '', fields, homePattern(options.homeDir));
  return fields;
}

function collectFields(
  value: unknown,
  path: string,
  fields: SettingsField[],
  home: HomePattern,
  fieldName = '',
  /**
   * True once any ancestor key was credential-shaped. Without it a credential
   * name that maps to a table or array of leaves — `[auth]`, `token = { … }` —
   * would publish every leaf under it verbatim, while the same name holding a
   * single scalar is redacted.
   */
  inheritsCredential = false
): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      collectFields(item, `${path}[${index}]`, fields, home, fieldName, inheritsCredential);
    }
    return;
  }

  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      // One marker at the root instead of descending. Dropping the subtree
      // silently made "this target has no such setting" and "this target has it
      // and we hid it" the same answer; marking every leaf would publish the
      // shape of the very thing being hidden.
      if (shouldOmitSubtree(key)) {
        fields.push({ path: relativizeHome(childPath, home), presentation: 'omitted' });
        continue;
      }
      collectFields(
        item,
        childPath,
        fields,
        home,
        key,
        inheritsCredential || isCredentialField(key, '')
      );
    }
    return;
  }

  const renderedValue = value instanceof Date ? value.toISOString() : String(value);
  const fieldPath = relativizeHome(path || '$', home);
  if (inheritsCredential || isCredentialField(fieldName, renderedValue)) {
    fields.push({ path: fieldPath, presentation: 'redacted' });
    return;
  }

  fields.push({
    path: fieldPath,
    presentation: 'value',
    value: relativizeHome(renderedValue, home),
  });
}

function isCredentialField(name: string, value: string): boolean {
  const normalizedName = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  return (
    looksCredentialShaped(normalizedName, value) || /(?:^|[_-])key(?:$|[_-])/i.test(normalizedName)
  );
}

function homePattern(homeDir: string): HomePattern {
  if (!homeDir) return null;
  const escapedHome = homeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escapedHome}(?=$|[\\\\/])`, 'g');
}

function relativizeHome(value: string, home: HomePattern): string {
  return home ? value.replace(home, '~') : value;
}

/**
 * Keys whose whole subtree is never walked: session state, caches, telemetry
 * ids and stored credentials. Reported as an `omitted` marker rather than
 * dropped — see {@link SettingsField} — but the content behind one is never
 * read, hashed, or counted.
 */
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
