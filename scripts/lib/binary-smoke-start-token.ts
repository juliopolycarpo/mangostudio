/**
 * The binary smoke's check that a compiled hub records who it is. The hub CLI tells the hub from a
 * process that reused its pid by comparing the `startToken` in `~/.mango/run/server.json`; when
 * the hub cannot read its own token (on Windows, a `bun:ffi` load that fails inside the compiled
 * binary) the file just lacks the field and `stop` quietly falls back to "unconfirmed". No other
 * check sees that, so the smoke does.
 *
 * The token formats are owned by `apps/api/src/lib/process-start-token.ts`; this file only reads
 * them, so a format change there fails the smoke here with the value it read.
 */

/** .NET `DateTime` ticks (100 ns since 0001-01-01 UTC) at the Unix epoch. */
const DOTNET_TICKS_AT_UNIX_EPOCH = 621_355_968_000_000_000n;
const DOTNET_TICKS_PER_MS = 10_000n;

/** Linux `USER_HZ`, the unit of `/proc/<pid>/stat` field 22. */
const LINUX_CLOCK_TICKS_PER_SECOND = 100;

export interface StartTokenContext {
  readonly platform: NodeJS.Platform;
  /** The time the token was read, epoch ms. */
  readonly nowMs: number;
  /** System uptime in seconds at `nowMs`; only Linux needs it. */
  readonly uptimeSeconds: number;
}

/**
 * The process start (epoch ms) a token encodes, or `undefined` when the token does not have the
 * platform's shape. Linux `<boot_id>:<start ticks>`, macOS the `ps -o lstart=` text in UTC,
 * Windows .NET ticks in UTC.
 *
 * @example
 * decodeStartToken('639418232000000000', { platform: 'win32', nowMs: 0, uptimeSeconds: 0 });
 */
export function decodeStartToken(token: string, context: StartTokenContext): number | undefined {
  if (context.platform === 'win32') {
    if (!/^\d{18,19}$/.test(token)) return undefined;
    return Number((BigInt(token) - DOTNET_TICKS_AT_UNIX_EPOCH) / DOTNET_TICKS_PER_MS);
  }
  if (context.platform === 'linux') {
    const match = /^[0-9a-f-]+:(\d+)$/i.exec(token);
    if (!match) return undefined;
    const ageSeconds = context.uptimeSeconds - Number(match[1]) / LINUX_CLOCK_TICKS_PER_SECOND;
    return Math.round(context.nowMs - ageSeconds * 1000);
  }
  // `lstart` is read with TZ=UTC, so the text names a UTC instant.
  if (!/^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d\d:\d\d:\d\d \d{4}$/.test(token)) return undefined;
  const parsed = Date.parse(`${token} UTC`);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export interface StartTokenWindow {
  /** Epoch ms before the hub was spawned. */
  readonly spawnedAtMs: number;
  /** Slack on both ends: `lstart` has one-second resolution and the clocks are read apart. */
  readonly toleranceMs: number;
}

/**
 * A description of what is wrong with the hub's recorded `startToken`, or `undefined` when it is
 * a non-empty token that decodes to a start inside `[spawnedAtMs - tolerance, now + tolerance]`.
 * The message names the field and the value read.
 *
 * @example
 * startTokenProblem(state.startToken, { platform: 'win32', nowMs: Date.now(), uptimeSeconds: 0 }, window);
 */
export function startTokenProblem(
  startToken: unknown,
  context: StartTokenContext,
  window: StartTokenWindow
): string | undefined {
  if (typeof startToken !== 'string' || startToken === '') {
    return `state file startToken: expected a non-empty string | received: ${JSON.stringify(startToken) ?? 'undefined'}`;
  }
  const startMs = decodeStartToken(startToken, context);
  if (startMs === undefined) {
    return `state file startToken: expected the ${context.platform} token shape | received: ${JSON.stringify(startToken)}`;
  }
  const earliest = window.spawnedAtMs - window.toleranceMs;
  const latest = context.nowMs + window.toleranceMs;
  if (startMs < earliest || startMs > latest) {
    return `state file startToken ${JSON.stringify(startToken)} decodes to a start of ${new Date(startMs).toISOString()}: expected between ${new Date(earliest).toISOString()} and ${new Date(latest).toISOString()}`;
  }
  return undefined;
}

export interface AwaitStartTokenOptions {
  /** The state file's text, or `undefined` when it is not there yet. */
  readonly readStateText: () => Promise<string | undefined>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly budgetMs: number;
  readonly intervalMs: number;
}

/**
 * The `startToken` field of the state file once it is a non-empty string, or whatever the last
 * read held when `budgetMs` passes (`undefined` for a missing file, field or unparseable text).
 * Windows writes the file first and adds the token a moment later, so one read can be early.
 *
 * @example
 * const token = await awaitStartToken({ readStateText, sleep: Bun.sleep, now: Date.now, budgetMs: 10_000, intervalMs: 100 });
 */
export async function awaitStartToken(options: AwaitStartTokenOptions): Promise<unknown> {
  const deadline = options.now() + options.budgetMs;
  for (;;) {
    const token = parseStartToken(await options.readStateText());
    if ((typeof token === 'string' && token !== '') || options.now() >= deadline) return token;
    await options.sleep(options.intervalMs);
  }
}

function parseStartToken(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return (JSON.parse(text) as { startToken?: unknown } | null)?.startToken;
  } catch {
    return undefined;
  }
}
