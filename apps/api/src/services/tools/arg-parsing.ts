/**
 * Shared argument-parsing helpers for tool executors that receive raw JSON
 * objects from provider streams.
 */

/** Model-supplied arguments failed validation; classified as `validation_failed`. */
export class ToolArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolArgumentError';
  }
}

export function getRequiredString(value: unknown, name: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new ToolArgumentError(`Missing required field "${name}".`);
  return text;
}

/**
 * Reads a required string argument verbatim. File content is the payload, not an
 * identifier: trimming it would silently drop the trailing newline a text file
 * is expected to end with, and rejecting `''` would make an empty file
 * impossible to write.
 *
 * // Usage: const content = getRequiredTextArg(args.content, 'content');
 */
export function getRequiredTextArg(value: unknown, name: string): string {
  if (value === undefined) throw new ToolArgumentError(`Missing required field "${name}".`);
  if (typeof value !== 'string') {
    throw new ToolArgumentError(`Field "${name}" must be a string.`);
  }
  return value;
}

/**
 * Reads a required integer argument, rejecting fractions and non-numbers rather
 * than rounding: a line number the model guessed at is a bug, not an input to
 * clamp.
 *
 * // Usage: const startLine = getRequiredInteger(args.startLine, 'startLine');
 */
export function getRequiredInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ToolArgumentError(`Field "${name}" must be an integer.`);
  }
  return value;
}

/**
 * Reads an optional boolean argument, distinguishing "absent" from "not a
 * boolean" so a truthy string never silently enables a flag.
 *
 * // Usage: const replaceAll = getOptionalBoolean(args.replaceAll, 'replaceAll');
 */
export function getOptionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new ToolArgumentError(`Field "${name}" must be a boolean.`);
  }
  return value;
}

export function getOptionalString(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || undefined;
}

export function getBoundedOptionalInteger(
  value: unknown,
  name: string,
  bounds: { min: number; max: number }
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ToolArgumentError(`Field "${name}" must be a finite number.`);
  }
  return Math.max(bounds.min, Math.min(bounds.max, Math.round(value)));
}

/**
 * Clamps an unknown value to an integer inside [min, max], falling back to
 * `fallback` for non-numeric or non-finite input. Shared by tool settings
 * normalizers so bounds semantics never drift between tools.
 *
 * // Usage: clampIntegerSetting(parameters.maxResults, 100, 1, 5000)
 */
export function clampIntegerSetting(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), min), max);
}
