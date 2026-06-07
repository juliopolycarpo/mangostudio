import { readFileSync } from 'node:fs';

export type RuntimeEnvMap = Record<string, string>;

/**
 * Parses runtime env text using MangoStudio's intentionally small KEY=value format.
 * // Usage: parseRuntimeEnvContent('API_PORT=3001')
 */
export function parseRuntimeEnvContent(content: string): RuntimeEnvMap {
  const result: RuntimeEnvMap = {};

  for (const line of content.split('\n')) {
    const parsed = parseRuntimeEnvLine(line);
    if (!parsed) continue;
    result[parsed.key] = parsed.value;
  }

  return result;
}

/**
 * Reads and parses a runtime .env file, returning an empty map when unavailable.
 * // Usage: parseRuntimeEnvFile('/home/me/.mango/.env')
 */
export function parseRuntimeEnvFile(filePath: string): RuntimeEnvMap {
  try {
    return parseRuntimeEnvContent(readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function parseRuntimeEnvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  const separatorIndex = trimmed.indexOf('=');
  if (separatorIndex === -1) return null;

  const key = trimmed.slice(0, separatorIndex).trim();
  if (!key) return null;

  const value = trimmed.slice(separatorIndex + 1).trim();
  return { key, value: stripMatchingQuotes(value) };
}

function stripMatchingQuotes(value: string): string {
  if (value.length < 2) return value;

  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' || first === "'") && first === last) {
    return value.slice(1, -1);
  }

  return value;
}
