// The guards and small helpers every script under `scripts/` shares: the JSON object and
// positive-integer guards, SHA-256 digests, and POSIX path separators.
//
// Dependency-free (Node built-ins only, no TypeBox): `lib/rust-lanes.ts` and the CI `changes`
// jobs import this module before `bun install` has run.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sep } from 'node:path';

/** Longest `received` rendering a guard failure carries before it is cut. */
export const MAX_RECEIVED_LENGTH = 200;

/**
 * Renders a rejected value for a failure message without ever throwing: strings, numbers (NaN and
 * Infinity included, which JSON would report as `null`), bigints, `undefined`, functions and
 * symbols get a readable form; objects are JSON with cycles marked `[Circular]`; anything past
 * {@link MAX_RECEIVED_LENGTH} characters is cut with its full length noted.
 * // Usage: describeReceived(undefined) // 'undefined'
 */
export function describeReceived(value: unknown): string {
  const rendered = renderReceived(value);
  return rendered.length <= MAX_RECEIVED_LENGTH
    ? rendered
    : `${rendered.slice(0, MAX_RECEIVED_LENGTH)}... (${rendered.length} characters in total)`;
}

function renderReceived(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
  if (typeof value === 'symbol') return String(value);
  const unserializable = `[unserializable ${typeof value}]`;
  try {
    // An object that holds a bigint or a cycle makes `JSON.stringify` throw; the replacer keeps
    // the rest of the payload readable instead of dropping the whole rendering.
    const ancestors: unknown[] = [];
    return (
      JSON.stringify(value, function (this: unknown, _key: string, child: unknown) {
        if (typeof child === 'bigint') return `${child}n`;
        if (typeof child === 'number' && !Number.isFinite(child)) return String(child);
        if (typeof child !== 'object' || child === null) return child;
        // `this` is the holder of `child`: every ancestor deeper than it has been left.
        while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
        if (ancestors.includes(child)) return '[Circular]';
        ancestors.push(child);
        return child;
      }) ?? unserializable
    );
  } catch {
    // A throwing `toJSON` or getter: name the kind of value instead of hiding the real failure.
    return unserializable;
  }
}

/**
 * The one failure every guard here throws: names the label, the expected shape and the value.
 * // Usage: invalidValue('CI run', 'object', null) // Error('Invalid CI run: expected object; received null')
 */
export function invalidValue(label: string, expected: string, value: unknown): Error {
  return new Error(`Invalid ${label}: expected ${expected}; received ${describeReceived(value)}`);
}

/**
 * True for a JSON object: not null and not an array.
 * // Usage: isJsonRecord({ id: 1 }) // true
 */
export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns `value` as a JSON object, or throws naming `label` and the value it rejected.
 * // Usage: requireJsonRecord(body, 'release listing entry') // body
 */
export function requireJsonRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isJsonRecord(value)) throw invalidValue(label, 'object', value);
  return value;
}

/**
 * Returns `value` when it is a safe integer of at least 1, or throws naming `label` and the value.
 * // Usage: requirePositiveSafeInteger(run.id, 'CI run id') // 42
 */
export function requirePositiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw invalidValue(label, 'positive safe integer', value);
  }
  return value;
}

/**
 * Lowercase hex SHA-256 of `bytes`.
 * // Usage: sha256OfBytes(Buffer.from('abc')) // 'ba7816bf...'
 */
export function sha256OfBytes(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Lowercase hex SHA-256 of a file's bytes, read synchronously and whole. Streams belong to the
 * callers that hash artifacts too large to hold in memory.
 * // Usage: sha256OfFile('release-assets/app.tar.gz') // 'ba7816bf...'
 */
export function sha256OfFile(filePath: string): string {
  return sha256OfBytes(readFileSync(filePath));
}

/**
 * Rewrites the host's path separator to `/`, so a path from `relative()` or `join()` reads the
 * same on Windows as on POSIX.
 * // Usage: toPosixPath(join('apps', 'api')) // 'apps/api'
 */
export function toPosixPath(path: string): string {
  return path.split(sep).join('/');
}
