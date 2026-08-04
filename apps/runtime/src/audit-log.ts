/**
 * Local receipt of what a hub asked this runtime to do.
 *
 * One NDJSON line per protocol method, written under the slot directory. The
 * hub never reads this file — there is no protocol method for it, and adding
 * one is a review flag. Arguments are recorded; contents are not. A full disk
 * degrades the log, never the request path.
 */

import {
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import { type RuntimeSlot, runtimeSlotAuditLogPath } from '@mangostudio/shared/runtime-home';
import type { RuntimeHubIdentity } from '@mangostudio/shared/runtime-protocol';
import { loadRuntimeConfig } from './config';

export type RuntimeAuditOutcome = 'ok' | 'denied' | 'error';

/** One line on disk. Safe to paste into an issue — no payload bytes, no secrets. */
export interface RuntimeAuditRecord {
  readonly ts: string;
  readonly method: string;
  readonly hub: string;
  readonly outcome: RuntimeAuditOutcome;
  readonly durationMs: number;
  /** Identifying arguments only — paths, argv summaries, byte counts. */
  readonly args?: Readonly<Record<string, unknown>>;
  /** Capability named by a `RUNTIME_DENIED` refusal. */
  readonly capability?: string;
  readonly code?: string;
}

export interface RuntimeAuditSinkOptions {
  readonly slot: RuntimeSlot;
  readonly enabled: boolean;
  readonly env?: NodeJS.ProcessEnv;
  /** Cap for the active log file before rotation. Injectable for tests. */
  readonly maxBytes?: number;
  /** How many rotated siblings to keep (`audit.log.1` … `audit.log.N`). */
  readonly maxFiles?: number;
  /** How often buffered lines are flushed. Injectable for tests. */
  readonly flushIntervalMs?: number;
  /** Override the log path (tests). */
  readonly path?: string;
}

export interface RuntimeAuditSink {
  readonly enabled: boolean;
  readonly path: string;
  /** Last write failure, if any — doctor reports this as unhealthy. */
  lastError(): string | null;
  setHub(hub: RuntimeHubIdentity | null): void;
  record(input: {
    readonly method: string;
    readonly outcome: RuntimeAuditOutcome;
    readonly durationMs: number;
    readonly params?: unknown;
    readonly capability?: string;
    readonly code?: string;
  }): void;
  /** Force a flush; used by CLI and tests. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_MAX_BYTES = 1_048_576;
const DEFAULT_MAX_FILES = 3;
const DEFAULT_FLUSH_INTERVAL_MS = 1_000;
const UNIDENTIFIED_HUB = 'unidentified hub';
const ARGV_SUMMARY_LIMIT = 8;
const STRING_SUMMARY_LIMIT = 256;

/**
 * Builds a sink that buffers lines and flushes on an interval. When `enabled`
 * is false, every method is a no-op — host slots default off.
 */
export function createRuntimeAuditSink(options: RuntimeAuditSinkOptions): RuntimeAuditSink {
  const env = options.env;
  const path =
    options.path ??
    runtimeSlotAuditLogPath(options.slot, {
      mangoHome: loadRuntimeConfig(env).mangoHome,
      platform: process.platform,
    });
  if (!options.enabled) {
    return disabledSink(path);
  }

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;

  let hubLabel = UNIDENTIFIED_HUB;
  let lastError: string | null = null;
  let buffer: string[] = [];
  let flushing: Promise<void> | null = null;
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const errorPath = `${path}.error`;

  const setError = async (message: string | null): Promise<void> => {
    lastError = message;
    try {
      if (message === null) {
        await unlink(errorPath).catch(() => undefined);
      } else {
        await mkdir(dirname(errorPath), { recursive: true });
        await writeFile(errorPath, `${message}\n`, 'utf8');
      }
    } catch {
      // Persisting the failure must not itself take the runtime down.
    }
  };

  const schedule = () => {
    if (timer !== undefined || closed) return;
    timer = setInterval(() => {
      void flush();
    }, flushIntervalMs);
    // The interval must not keep a process that only has idle audit work alive.
    timer.unref?.();
  };

  const flush = (): Promise<void> => {
    if (flushing) return flushing;
    if (buffer.length === 0) return Promise.resolve();
    const batch = buffer;
    buffer = [];
    flushing = writeBatch(path, batch, maxBytes, maxFiles)
      .then(async () => {
        await setError(null);
      })
      .catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        await setError(message);
        // Put the batch back so a transient failure can retry; drop if closed.
        if (!closed) buffer = [...batch, ...buffer];
      })
      .finally(() => {
        flushing = null;
      });
    return flushing;
  };

  schedule();

  return {
    enabled: true,
    path,
    lastError: () => lastError,
    setHub(hub) {
      hubLabel = hub ? formatHubIdentity(hub) : UNIDENTIFIED_HUB;
    },
    record(input) {
      if (closed) return;
      const args = summarizeAuditArgs(input.method, input.params);
      const record: RuntimeAuditRecord = {
        ts: new Date().toISOString(),
        method: input.method,
        hub: hubLabel,
        outcome: input.outcome,
        durationMs: Math.max(0, Math.round(input.durationMs)),
        ...(input.capability ? { capability: input.capability } : {}),
        ...(input.code ? { code: input.code } : {}),
        ...(args ? { args } : {}),
      };
      buffer.push(`${JSON.stringify(record)}\n`);
      schedule();
    },
    async flush() {
      await flush();
    },
    async close() {
      closed = true;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      await flush();
    },
  };
}

function disabledSink(path: string): RuntimeAuditSink {
  return {
    enabled: false,
    path,
    lastError: () => null,
    setHub() {
      // Disabled sinks ignore hub identity.
    },
    record() {
      // Disabled sinks drop every line.
    },
    async flush() {
      // Nothing buffered.
    },
    async close() {
      // Nothing to release.
    },
  };
}

function formatHubIdentity(hub: RuntimeHubIdentity): string {
  return `${hub.user}@${hub.host}`;
}

/**
 * Identifying arguments only. Paths and argv summaries yes; file contents,
 * MCP secrets, pairing tokens, update chunk bytes, and env values never.
 */
export function summarizeAuditArgs(
  method: string,
  params: unknown
): Readonly<Record<string, unknown>> | undefined {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const source = params as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  pickString(out, source, 'path');
  pickString(out, source, 'resolvedPath');
  pickString(out, source, 'inputPath');
  pickString(out, source, 'cwd');
  pickString(out, source, 'repo');
  pickString(out, source, 'workdir');
  pickString(out, source, 'runId');
  pickString(out, source, 'sessionId');
  pickString(out, source, 'serverId');
  pickString(out, source, 'id');
  pickString(out, source, 'slug');
  pickString(out, source, 'kind');
  pickString(out, source, 'command', STRING_SUMMARY_LIMIT);
  pickString(out, source, 'logPath');

  if (typeof source.size === 'number') out.bytes = source.size;
  if (typeof source.byteLength === 'number') out.bytes = source.byteLength;
  if (typeof source.totalBytes === 'number') out.bytes = source.totalBytes;
  if (typeof source.content === 'string') out.bytes = Buffer.byteLength(source.content, 'utf8');
  if (typeof source.bytesBase64 === 'string') {
    // Approximate decoded size without materializing the bytes.
    const padded = source.bytesBase64.endsWith('==') ? 2 : source.bytesBase64.endsWith('=') ? 1 : 0;
    out.bytes = (source.bytesBase64.length * 3) / 4 - padded;
  } else if (typeof source.bytes === 'string') {
    const padded = source.bytes.endsWith('==') ? 2 : source.bytes.endsWith('=') ? 1 : 0;
    out.bytes = (source.bytes.length * 3) / 4 - padded;
  }
  if (typeof source.seq === 'number') out.seq = source.seq;
  if (typeof source.version === 'string') out.version = truncate(source.version, 64);
  if (typeof source.digest === 'string') out.digest = truncate(source.digest, 80);

  if (Array.isArray(source.argv)) {
    out.argv = summarizeArgv(source.argv);
  }
  if (Array.isArray(source.args) && method.startsWith('mcp.')) {
    out.args = summarizeArgv(source.args);
  }

  // Never promote env / headers / secrets / content / token-shaped keys.
  return Object.keys(out).length > 0 ? out : undefined;
}

function pickString(
  out: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
  limit = STRING_SUMMARY_LIMIT
): void {
  const value = source[key];
  if (typeof value === 'string' && value.length > 0) {
    out[key] = truncate(value, limit);
  }
}

function summarizeArgv(argv: readonly unknown[]): readonly string[] {
  return argv
    .filter((entry): entry is string => typeof entry === 'string')
    .slice(0, ARGV_SUMMARY_LIMIT)
    .map((entry) => truncate(entry, STRING_SUMMARY_LIMIT));
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

async function writeBatch(
  path: string,
  batch: readonly string[],
  maxBytes: number,
  maxFiles: number
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // One line at a time so a busy flush rotates between lines instead of
  // parking an entire batch in a single oversized generation.
  for (const line of batch) {
    await appendFile(path, line, 'utf8');
    await rotateIfNeeded(path, maxBytes, maxFiles);
  }
}

/**
 * When the active file exceeds `maxBytes`, shift `audit.log.N` up and start a
 * fresh active file. Oldest beyond `maxFiles` is dropped. Size is checked after
 * append so a single oversized batch can still briefly exceed the cap; the next
 * flush brings the budget back.
 */
export async function rotateIfNeeded(
  path: string,
  maxBytes: number,
  maxFiles: number
): Promise<void> {
  let size = 0;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  if (size <= maxBytes) return;

  for (let index = maxFiles; index >= 1; index -= 1) {
    const from = index === 1 ? path : `${path}.${index - 1}`;
    const to = `${path}.${index}`;
    try {
      if (index === maxFiles) {
        await unlink(to).catch(() => undefined);
        // Dropping the oldest: if it is still there after unlink failure we
        // overwrite via rename below when possible.
      }
      await rename(from, to);
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
  }
  // After shifting, the active path should be gone. Open with append mode so
  // create-if-missing is a single syscall — no check-then-write race on the
  // path, and no truncate if another writer already recreated it.
  const handle = await open(path, 'a');
  await handle.close();
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

export interface ReadRuntimeAuditOptions {
  readonly path: string;
  /** ISO-8601 lower bound; lines without a parseable `ts` are kept. */
  readonly since?: string;
  readonly deniedOnly?: boolean;
}

/** Reads and filters the active log plus rotated siblings, oldest first. */
export async function readRuntimeAuditLog(
  options: ReadRuntimeAuditOptions
): Promise<readonly RuntimeAuditRecord[]> {
  const paths = await listAuditLogPaths(options.path);
  const sinceMs = options.since ? Date.parse(options.since) : Number.NaN;
  const records: RuntimeAuditRecord[] = [];

  for (const file of paths) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!isAuditRecord(parsed)) continue;
      if (options.deniedOnly && parsed.outcome !== 'denied') continue;
      if (Number.isFinite(sinceMs)) {
        const ts = Date.parse(parsed.ts);
        if (Number.isFinite(ts) && ts < sinceMs) continue;
      }
      records.push(parsed);
    }
  }
  return records;
}

async function listAuditLogPaths(path: string): Promise<readonly string[]> {
  const ordered: string[] = [];
  // Rotated siblings first (oldest → newest), then the active file.
  for (let index = 20; index >= 1; index -= 1) {
    const candidate = `${path}.${index}`;
    try {
      await stat(candidate);
      ordered.push(candidate);
    } catch {
      // absent
    }
  }
  try {
    await stat(path);
    ordered.push(path);
  } catch {
    // absent
  }
  return ordered;
}

function isAuditRecord(value: unknown): value is RuntimeAuditRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.ts === 'string' &&
    typeof record.method === 'string' &&
    typeof record.hub === 'string' &&
    (record.outcome === 'ok' || record.outcome === 'denied' || record.outcome === 'error') &&
    typeof record.durationMs === 'number'
  );
}

/** Resolve `--since` values: ISO-8601, or a relative `Nh` / `Nm` / `Nd`. */
export function parseAuditSince(value: string): string | { readonly error: string } {
  const trimmed = value.trim();
  if (!trimmed)
    return { error: '--since needs an ISO-8601 instant or a relative duration like 24h.' };
  const relative = /^(\d+)([smhd])$/i.exec(trimmed);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = (relative[2] ?? '').toLowerCase();
    const ms =
      unit === 's'
        ? amount * 1_000
        : unit === 'm'
          ? amount * 60_000
          : unit === 'h'
            ? amount * 3_600_000
            : amount * 86_400_000;
    return new Date(Date.now() - ms).toISOString();
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    return {
      error: `--since "${trimmed}" is not an ISO-8601 instant or a relative duration like 24h.`,
    };
  }
  return new Date(parsed).toISOString();
}

/** Reads a persisted write failure left by a prior flush, if any. */
export async function readRuntimeAuditError(path: string): Promise<string | null> {
  try {
    const text = (await readFile(`${path}.error`, 'utf8')).trim();
    return text.length > 0 ? text : null;
  } catch (error) {
    if (isNotFound(error)) return null;
    return error instanceof Error ? error.message : String(error);
  }
}

/** Rotated sibling path for the active log (`audit.log.1`, …). */
export function auditLogRotatedPath(path: string, index: number): string {
  return index <= 0 ? path : `${path}.${index}`;
}
