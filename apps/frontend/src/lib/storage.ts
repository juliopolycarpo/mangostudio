/* global localStorage, console */

const PREFIX = 'mangostudio:';

/**
 * Read a JSON value from localStorage, validating that the parsed result
 * matches the expected type of the fallback. Returns the fallback on any
 * failure (missing key, corrupt JSON, type mismatch).
 */
export function readStorage(key: string, fallback: string): string;
export function readStorage(key: string, fallback: number): number;
export function readStorage(key: string, fallback: boolean): boolean;
export function readStorage(
  key: string,
  fallback: string | number | boolean
): string | number | boolean {
  try {
    const raw = localStorage.getItem(`${PREFIX}${key}`);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === typeof fallback) return parsed as typeof fallback;
    return fallback;
  } catch {
    return fallback;
  }
}

/** Write a JSON value to localStorage. */
export function writeStorage(key: string, value: unknown): void {
  try {
    localStorage.setItem(`${PREFIX}${key}`, JSON.stringify(value));
  } catch (error) {
    console.error(`Failed to save ${key} to localStorage`, error);
  }
}
