// Process receipts shared by the watchdog, artifact merger and QA evidence reader.
// Version 1 requires identity, exit, duration, attempt count and retained findings.
// Unversioned receipts are legacy: identity and exit are still required, while
// omitted duration/attempts/findings are unavailable (null), never measured zero
// or an invented first attempt. A malformed field is invalid in either format.

export type ShardIdentity = number | string;

export interface CurrentShardReceipt {
  readonly schemaVersion: 1;
  readonly shard: ShardIdentity;
  readonly exitCode: number;
  readonly durationSeconds: number;
  readonly attempts: number;
  readonly failuresSeen: boolean;
}

/** Decoded receipt: legacy omitted fields remain explicitly unavailable. */
export type ShardReceipt = Omit<
  CurrentShardReceipt,
  'schemaVersion' | 'durationSeconds' | 'attempts' | 'failuresSeen'
> & {
  readonly durationSeconds: number | null;
  readonly attempts: number | null;
  readonly failuresSeen: boolean | null;
};

export interface ReceiptRequirements {
  /** Artifact consumers compare the producer with the expected job directory. */
  readonly expectedShard?: ShardIdentity;
  /** Producers require measured fields; legacy consumers may leave them unavailable. */
  readonly requireDuration?: boolean;
  readonly requireAttempts?: boolean;
}

export type ParsedShardReceipt =
  | { readonly kind: 'valid'; readonly receipt: ShardReceipt }
  | { readonly kind: 'invalid'; readonly why: string };

const invalid = (why: string): ParsedShardReceipt => ({ kind: 'invalid', why });
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// `String` for numbers so NaN and Infinity are not reported as JSON's `null`.
const found = (value: unknown): string =>
  typeof value === 'number' || value === undefined
    ? String(value)
    : // eslint-disable-next-line @typescript-eslint/no-base-to-string -- Diagnostics intentionally describe arbitrary invalid input, including non-scalar values.
      (JSON.stringify(value) ?? String(value));

/**
 * A process exit status a receipt may carry: an integer from 0 to 255.
 * // Usage: isReceiptExitCode(124) // true
 */
export const isReceiptExitCode = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 255;

/**
 * A measured wall clock: a nonnegative finite number of seconds.
 * // Usage: isReceiptDuration(0) // true
 */
export const isReceiptDuration = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * A job identity: a positive shard number or a lowercase lane name.
 * // Usage: isShardIdentity('frontend') // true
 */
export const isShardIdentity = (value: unknown): value is ShardIdentity =>
  (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) ||
  (typeof value === 'string' && /^[a-z][a-z0-9-]*$/.test(value));

/**
 * Validate decoded JSON, with additional fields required by the consumer.
 * // Usage: validateShardReceipt({ shard: 1, exitCode: 0 }) // { kind: 'valid', receipt: { durationSeconds: null, ... } }
 */
export const validateShardReceipt = (
  value: unknown,
  requirements: ReceiptRequirements = {}
): ParsedShardReceipt => {
  if (!record(value)) return invalid(`shard-meta.json must be an object (found ${found(value)})`);
  const current = value.schemaVersion === 1;
  if (value.schemaVersion !== undefined && !current) {
    return invalid(
      `shard-meta.json has an unsupported schemaVersion (found ${found(value.schemaVersion)}; expected 1 or absent)`
    );
  }
  if (!isShardIdentity(value.shard)) {
    return invalid(
      `shard-meta.json has no valid shard identity (found ${found(value.shard)}; expected a positive integer or a lowercase lane name)`
    );
  }
  if (requirements.expectedShard !== undefined && value.shard !== requirements.expectedShard) {
    return invalid(
      `shard-meta.json identifies ${JSON.stringify(value.shard)}; expected ${JSON.stringify(requirements.expectedShard)}`
    );
  }
  if (!isReceiptExitCode(value.exitCode)) {
    return invalid(
      `shard-meta.json has no valid exitCode (found ${found(value.exitCode)}; expected an integer from 0 to 255)`
    );
  }
  if (value.durationSeconds !== undefined && !isReceiptDuration(value.durationSeconds)) {
    return invalid(
      `shard-meta.json has an invalid durationSeconds (found ${found(value.durationSeconds)}; expected a nonnegative finite number)`
    );
  }
  if ((current || requirements.requireDuration) && value.durationSeconds === undefined) {
    return invalid('shard-meta.json has no durationSeconds (expected a nonnegative finite number)');
  }
  if (
    value.attempts !== undefined &&
    (typeof value.attempts !== 'number' ||
      !Number.isSafeInteger(value.attempts) ||
      value.attempts < 1 ||
      (current && value.attempts > 2))
  ) {
    return invalid(
      `shard-meta.json has an invalid attempts count (found ${found(value.attempts)}; expected ${current ? '1 or 2' : 'a positive integer'})`
    );
  }
  if ((current || requirements.requireAttempts) && value.attempts === undefined) {
    return invalid('shard-meta.json has no attempts count (expected a positive integer)');
  }
  if (value.failuresSeen !== undefined && typeof value.failuresSeen !== 'boolean') {
    return invalid(
      `shard-meta.json has an invalid failuresSeen flag (found ${found(value.failuresSeen)}; expected a boolean)`
    );
  }
  if (current && value.failuresSeen === undefined) {
    return invalid('shard-meta.json has no failuresSeen flag (expected a boolean)');
  }
  const attempts = typeof value.attempts === 'number' ? value.attempts : null;
  const failuresSeen = typeof value.failuresSeen === 'boolean' ? value.failuresSeen : null;
  if (failuresSeen === true && attempts === null) {
    return invalid('shard-meta.json retains findings without an attempts count');
  }
  return {
    kind: 'valid',
    receipt: {
      shard: value.shard,
      exitCode: value.exitCode === 0 && failuresSeen ? 1 : value.exitCode,
      durationSeconds: typeof value.durationSeconds === 'number' ? value.durationSeconds : null,
      attempts,
      failuresSeen,
    },
  };
};

/**
 * Parse an artifact without letting corrupt or truncated JSON look like exit 0.
 * // Usage: parseShardReceipt(text, { expectedShard: 3 }).kind // 'valid' | 'invalid'
 */
export const parseShardReceipt = (
  text: string | null,
  requirements: ReceiptRequirements = {}
): ParsedShardReceipt => {
  if (text === null) return invalid('no shard-meta.json');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return invalid('shard-meta.json is not valid JSON');
  }
  return validateShardReceipt(value, requirements);
};

/**
 * Serialize only a valid current producer receipt, preserving retained failures.
 * // Usage: serializeShardReceipt({ schemaVersion: 1, shard: 3, exitCode: 0, durationSeconds: 41, attempts: 1, failuresSeen: false })
 */
export const serializeShardReceipt = (receipt: CurrentShardReceipt): string => {
  const parsed = validateShardReceipt(receipt, { requireDuration: true, requireAttempts: true });
  if (parsed.kind === 'invalid') throw new Error(parsed.why);
  return `${JSON.stringify({ ...receipt, exitCode: parsed.receipt.exitCode })}\n`;
};

/**
 * Identity encoded in an uploaded job's name; arbitrary directory names are invalid.
 * // Usage: shardIdentityFromDirectory('test-shard-3') // 3
 */
export const shardIdentityFromDirectory = (name: string): ShardIdentity | undefined => {
  const suffix = /^test-shard-(.+)$/.exec(name)?.[1];
  if (!suffix) return undefined;
  const identity = /^[1-9]\d*$/.test(suffix) ? Number(suffix) : suffix;
  return isShardIdentity(identity) ? identity : undefined;
};
