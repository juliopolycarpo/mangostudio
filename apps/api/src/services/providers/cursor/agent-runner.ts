/**
 * Spawns the Node.js Cursor SDK sidecar and maps NDJSON events to StreamingChunk.
 * Supports bidirectional stdio RPC so MangoStudio tools execute via executeTool in the API.
 *
 * Lifecycle guarantees:
 * - Startup handshake: the sidecar announces `{ type: "ready", protocolVersion }`
 *   as its first line; a missing handshake or protocol mismatch fails fast with
 *   a CursorSidecarError instead of hanging on a broken vendored tree.
 * - Watchdogs: an inactivity timeout (paused while a MangoStudio tool RPC is in
 *   flight) and a hard turn ceiling both surface as error chunks, never hangs.
 * - Kill escalation: abort and watchdog kills send SIGTERM, then SIGKILL after
 *   a grace period.
 */

import { createInterface } from 'node:readline';
import type { StreamingChunk } from '../types';
import { detectCursorRuntimeAvailability } from './runtime-availability';
import { resolveCursorRuntimeUnavailableMessage } from './runtime-reason';
import {
  CURSOR_SIDECAR_PROTOCOL_VERSION,
  formatCursorSidecarExit,
  spawnCursorSidecarProcess,
  terminateCursorSidecar,
  terminateCursorSidecarWithEscalation,
} from './sidecar-process';

export {
  buildCursorSidecarEnv,
  CURSOR_SIDECAR_PROTOCOL_VERSION,
  resolveCursorSidecarScriptPath,
} from './sidecar-process';

const READY_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 300_000;
const TURN_TIMEOUT_MS = 3_600_000;
const KILL_GRACE_MS = 2_000;
const STDERR_EXCERPT_MAX_CHARS = 2_000;

export interface CursorSidecarCustomTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CursorSidecarRequest {
  apiKey: string;
  model: string;
  cwd: string;
  prompt: string;
  params?: Array<{ id: string; value: string }>;
  customTools?: CursorSidecarCustomTool[];
  settingSources?: string[];
}

export interface CursorSidecarExecuteResult {
  result?: unknown;
  error?: string;
  isError?: boolean;
}

export interface StreamCursorAgentSidecarOptions {
  executeCustomTool?: (
    name: string,
    args: Record<string, unknown>
  ) => Promise<CursorSidecarExecuteResult>;
  /** Max wait for the sidecar's `ready` handshake (default 10s). */
  readyTimeoutMs?: number;
  /** Max stdout silence while no tool RPC is pending (default 5min). */
  idleTimeoutMs?: number;
  /** Hard ceiling on the whole turn (default 60min). */
  turnTimeoutMs?: number;
  /** Grace period between SIGTERM and SIGKILL (default 2s). */
  killGraceMs?: number;
}

type SidecarEvent =
  | {
      type: 'text' | 'thinking' | 'error' | 'done';
      text?: string;
      content?: string;
      done?: boolean;
    }
  | {
      type: 'ready';
      protocolVersion?: number;
    }
  | {
      type: 'tool_call';
      callId?: string;
      name?: string;
      status?: string;
      args?: unknown;
      result?: unknown;
    }
  | {
      type: 'tool_request';
      id: string;
      name: string;
      args?: unknown;
    }
  | {
      type: 'tool_result';
      id?: string;
      name?: string;
      result?: unknown;
      isError?: boolean;
    };

function stringifySidecarResult(result: unknown): string | undefined {
  if (result === undefined) return undefined;
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function mapSidecarEvent(
  event: SidecarEvent,
  emittedToolCallIds: Set<string>
): StreamingChunk | null {
  switch (event.type) {
    case 'text':
      return event.text ? { type: 'text', text: event.text, done: false } : null;
    case 'thinking':
      return event.text ? { type: 'thinking', text: event.text, done: false } : null;
    case 'tool_call':
      if (shouldSkipToolCallEvent(event, emittedToolCallIds)) return null;
      return {
        type: 'tool_call',
        toolCallId: event.callId,
        name: event.name,
        args:
          typeof event.args === 'object' && event.args !== null
            ? (event.args as Record<string, unknown>)
            : undefined,
        content: stringifySidecarResult(event.result),
        done: false,
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        toolCallId: event.id,
        name: event.name,
        content: stringifySidecarResult(event.result) ?? '',
        isError: event.isError === true,
        done: false,
      };
    case 'error':
      return {
        type: 'error',
        content: event.content ?? 'Cursor agent run failed.',
        done: true,
      };
    default:
      return null;
  }
}

function shouldSkipToolCallEvent(
  event: Extract<SidecarEvent, { type: 'tool_call' }>,
  emittedToolCallIds: Set<string>
): boolean {
  if (event.status === 'running') return true;
  const callId = typeof event.callId === 'string' ? event.callId.trim() : '';
  if (!callId) return false;
  if (emittedToolCallIds.has(callId)) return true;
  emittedToolCallIds.add(callId);
  return false;
}

function writeToolResponse(
  stdin: NodeJS.WritableStream,
  response: { type: 'tool_response'; id: string } & CursorSidecarExecuteResult
): void {
  try {
    stdin.write(`${JSON.stringify(response)}\n`);
  } catch {
    // Sidecar may have exited; swallow EPIPE.
  }
}

/** Appends a truncated stderr tail to an error message for diagnosability. */
function withStderrExcerpt(message: string, stderr: string): string {
  const tail = stderr.trim().slice(-STDERR_EXCERPT_MAX_CHARS);
  return tail ? `${message}\nSidecar stderr:\n${tail}` : message;
}

type LineReadResult = { kind: 'line'; line: string } | { kind: 'eof' } | { kind: 'timeout' };

interface DeadlineLineReader {
  next(timeoutMs: number): Promise<LineReadResult>;
  close(): void;
}

/**
 * Wraps readline's push events into a single-consumer pull API so each read
 * can carry its own watchdog deadline (readline's async iterator cannot).
 */
function createDeadlineLineReader(input: NodeJS.ReadableStream): DeadlineLineReader {
  const rl = createInterface({ input });
  const buffered: string[] = [];
  let eof = false;
  let notify: (() => void) | null = null;

  rl.on('line', (line) => {
    buffered.push(line);
    notify?.();
  });
  rl.on('close', () => {
    eof = true;
    notify?.();
  });

  return {
    async next(timeoutMs: number): Promise<LineReadResult> {
      const deadline = Date.now() + Math.max(0, timeoutMs);
      while (true) {
        const line = buffered.shift();
        if (line !== undefined) return { kind: 'line', line };
        if (eof) return { kind: 'eof' };

        const remaining = deadline - Date.now();
        if (remaining <= 0) return { kind: 'timeout' };

        const arrived = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            notify = null;
            resolve(false);
          }, remaining);
          timer.unref?.();
          notify = () => {
            clearTimeout(timer);
            notify = null;
            resolve(true);
          };
        });
        if (!arrived) return { kind: 'timeout' };
      }
    },
    close: () => rl.close(),
  };
}

export async function* streamCursorAgentSidecar(
  request: CursorSidecarRequest,
  signal?: AbortSignal,
  options: StreamCursorAgentSidecarOptions = {}
): AsyncIterable<StreamingChunk> {
  const runtime = await detectCursorRuntimeAvailability();
  if (!runtime.available || !runtime.nodePath) {
    throw new CursorSidecarError(resolveCursorRuntimeUnavailableMessage(runtime));
  }

  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const turnTimeoutMs = options.turnTimeoutMs ?? TURN_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;

  const sidecar = spawnCursorSidecarProcess({
    nodePath: runtime.nodePath,
    sidecarScriptPath: runtime.sidecarScriptPath,
  });
  const { child, childExit } = sidecar;

  const killWithEscalation = () => {
    void terminateCursorSidecarWithEscalation(child, childExit, killGraceMs);
  };
  const abortHandler = killWithEscalation;
  signal?.addEventListener('abort', abortHandler, { once: true });

  const reader = createDeadlineLineReader(child.stdout);

  try {
    if (signal?.aborted) {
      abortHandler();
      return;
    }

    child.stdin.write(`${JSON.stringify(request)}\n`);

    let sawTerminal = false;
    let sawFirstEvent = false;
    let pendingToolRpcCount = 0;
    const emittedToolCallIds = new Set<string>();
    const turnDeadline = Date.now() + turnTimeoutMs;

    while (true) {
      if (signal?.aborted) break;

      const inactivityBudget = sawFirstEvent ? idleTimeoutMs : readyTimeoutMs;
      const read = await reader.next(Math.min(inactivityBudget, turnDeadline - Date.now()));
      if (read.kind === 'eof') break;

      if (read.kind === 'timeout') {
        if (signal?.aborted) break;

        if (Date.now() >= turnDeadline) {
          killWithEscalation();
          yield {
            type: 'error',
            content: `Cursor agent turn exceeded the ${Math.round(turnTimeoutMs / 1000)}s limit and was terminated.`,
            done: true,
          };
          return;
        }

        if (!sawFirstEvent) {
          killWithEscalation();
          throw new CursorSidecarError(
            withStderrExcerpt(
              `Cursor sidecar failed to start within ${Math.round(readyTimeoutMs / 1000)}s.`,
              sidecar.getStderr()
            )
          );
        }

        // A MangoStudio tool executing on the API side legitimately silences
        // the sidecar; only enforce inactivity when nothing is in flight.
        if (pendingToolRpcCount > 0) continue;

        killWithEscalation();
        yield {
          type: 'error',
          content: `Cursor sidecar produced no output for ${Math.round(idleTimeoutMs / 1000)}s and was terminated.`,
          done: true,
        };
        return;
      }

      if (!read.line.trim()) continue;

      let event: SidecarEvent;
      try {
        event = JSON.parse(read.line) as SidecarEvent;
      } catch {
        continue;
      }

      if (!sawFirstEvent) {
        sawFirstEvent = true;
        if (event.type === 'ready') {
          if (event.protocolVersion !== CURSOR_SIDECAR_PROTOCOL_VERSION) {
            killWithEscalation();
            throw new CursorSidecarError(
              `The MangoStudio binary and vendored Cursor sidecar are out of sync ` +
                `(protocol ${event.protocolVersion ?? 'unknown'}, expected ${CURSOR_SIDECAR_PROTOCOL_VERSION}). ` +
                'Reinstall MangoStudio.'
            );
          }
          continue;
        }
        // No handshake: tolerate custom sidecar_script overrides that predate it.
      } else if (event.type === 'ready') {
        continue;
      }

      if (event.type === 'done') {
        sawTerminal = true;
        break;
      }

      if (event.type === 'tool_request') {
        const { id, name } = event;
        const args =
          typeof event.args === 'object' && event.args !== null
            ? (event.args as Record<string, unknown>)
            : {};

        pendingToolRpcCount += 1;
        void (async () => {
          try {
            const outcome = options.executeCustomTool
              ? await options.executeCustomTool(name, args)
              : {
                  error: `Tool "${name}" is not available on the Cursor provider path.`,
                  isError: true,
                };
            writeToolResponse(child.stdin, { type: 'tool_response', id, ...outcome });
          } catch (error) {
            writeToolResponse(child.stdin, {
              type: 'tool_response',
              id,
              error: error instanceof Error ? error.message : 'Tool execution failed.',
              isError: true,
            });
          } finally {
            pendingToolRpcCount -= 1;
          }
        })();

        yield {
          type: 'tool_call',
          toolCallId: id,
          name,
          args,
          done: false,
        };
        continue;
      }

      const chunk = mapSidecarEvent(event, emittedToolCallIds);
      if (!chunk) continue;

      if (chunk.type === 'error') {
        sawTerminal = true;
        yield chunk;
        return;
      }

      yield chunk;
    }

    try {
      child.stdin.end();
    } catch {
      // Sidecar may have already closed stdin.
    }

    const exitStatus = await childExit;
    if (signal?.aborted) return;

    const spawnErrorMessage = sidecar.getSpawnErrorMessage();
    if (spawnErrorMessage) {
      yield {
        type: 'error',
        content: spawnErrorMessage,
        done: true,
      };
      return;
    }
    if (!sawTerminal && exitStatus.code !== 0) {
      yield {
        type: 'error',
        content: sidecar.getStderr().trim() || formatCursorSidecarExit(exitStatus),
        done: true,
      };
      return;
    }

    yield { type: 'text', text: '', done: true };
  } finally {
    signal?.removeEventListener('abort', abortHandler);
    reader.close();
    terminateCursorSidecar(child);
  }
}

export class CursorSidecarError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CursorSidecarError';
  }
}
