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
 * Reads a required non-empty string argument verbatim. Edge whitespace is
 * significant in a search expression: trimming `" TODO"` into `"TODO"` silently
 * matches something the caller never asked for, so only an absent, non-string,
 * or empty value is rejected.
 *
 * // Usage: const pattern = getRequiredVerbatimString(args.pattern, 'pattern');
 */
export function getRequiredVerbatimString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new ToolArgumentError(`Missing required field "${name}".`);
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
 * boolean" so a truthy string never silently enables a flag. `null` reads as
 * absent: OpenAI Responses strict schemas send null for an omitted optional,
 * and the executor treats both null and a missing key as absent.
 *
 * // Usage: const replaceAll = getOptionalBoolean(args.replaceAll, 'replaceAll');
 */
export function getOptionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new ToolArgumentError(`Field "${name}" must be a boolean.`);
  }
  return value;
}

/**
 * Reads an optional string argument, rejecting a non-string rather than
 * reading it as absent: a model that sends `{"path": 42}` and gets the working
 * directory back believes it listed the directory it named. `null` reads as
 * absent, matching both an omitted key and the nullable-optional spelling
 * Responses strict mode still uses on the wire.
 *
 * // Usage: const path = getOptionalString(args.path, 'path');
 */
export function getOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ToolArgumentError(`Field "${name}" must be a string.`);
  }
  return value.trim() || undefined;
}

/**
 * Reads an optional argument constrained to a fixed set of strings, rejecting
 * anything outside it. A value the schema advertises but the executor cannot
 * honour is model output to correct, not a default to silently substitute.
 *
 * // Usage: const view = getOptionalEnum(args.view, 'view', RUNTIME_READ_FILE_VIEWS);
 */
export function getOptionalEnum<const T extends readonly string[]>(
  value: unknown,
  name: string,
  allowed: T
): T[number] | undefined {
  const text = getOptionalString(value, name);
  if (text === undefined) return undefined;
  if (!allowed.includes(text)) {
    throw new ToolArgumentError(
      `Field "${name}" must be one of ${allowed.map((option) => `"${option}"`).join(', ')}.`
    );
  }
  return text;
}

/**
 * Reads an optional integer argument and clamps it into `bounds`. Clamping and
 * rounding are deliberately split: bounding `5e9` down to a ceiling keeps a
 * usable request usable, but rounding `2.6` to `3` reads a line the caller
 * never asked for — the case `getRequiredInteger` calls a bug rather than an
 * input to clamp.
 *
 * // Usage: const startLine = getBoundedOptionalInteger(args.startLine, 'startLine', bounds);
 */
export function getBoundedOptionalInteger(
  value: unknown,
  name: string,
  bounds: { min: number; max: number }
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ToolArgumentError(`Field "${name}" must be an integer.`);
  }
  return Math.max(bounds.min, Math.min(bounds.max, value));
}

/**
 * Drops `null`-valued keys, at any depth, so an explicitly-null optional reads
 * as absent.
 *
 * The object-level counterpart of the `null`-is-absent branch the scalar
 * readers above apply: tools that validate their arguments through a shared
 * TypeBox schema rather than these helpers normalize with this first. The
 * schema advertises optionals as `["string", "null"]` to stay inside the
 * provider strict subset, which is a wire-format concern only — the shared
 * contracts keep their plain optional keys, so nothing downstream has to spell
 * `| null`.
 *
 * // Usage: const normalized = stripNullOptionals(args);
 */
export function stripNullOptionals(value: Record<string, unknown>): Record<string, unknown>;
export function stripNullOptionals(value: unknown): unknown;
export function stripNullOptionals(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNullOptionals);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== null)
      .map(([key, entry]) => [key, stripNullOptionals(entry)])
  );
}

/**
 * Reads an optional string *setting*, coercing anything else to "unset".
 *
 * Deliberately laxer than `getOptionalString`: settings are stored
 * configuration, not model output, so a bad value falls back to the default
 * instead of failing the tool call the user is waiting on.
 *
 * // Usage: const defaultModel = getStringSetting(parameters.defaultModel);
 */
export function getStringSetting(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim() || undefined;
}

/**
 * Clamps an unknown value to an integer inside [min, max], falling back to
 * `fallback` for non-numeric or non-finite input. Shared by tool settings
 * normalizers so bounds semantics never drift between tools.
 *
 * Rounds where `getBoundedOptionalInteger` rejects, for the same reason
 * `getStringSetting` coerces: this reads a stored setting, not a model
 * argument, and there is no one to hand a correctable error to.
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
