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

import {
  NodeSidecarError,
  type NodeSidecarExecuteResult,
  streamNodeSidecarEvents,
} from '../core/node-sidecar/spawn-sidecar';
import type { StreamingChunk } from '../types';
import { detectCursorRuntimeAvailability } from './runtime-availability';
import { resolveCursorRuntimeUnavailableMessage } from './runtime-reason';
import {
  CURSOR_SIDECAR_PROTOCOL_VERSION,
  describeCursorSpawnError,
  resolveCursorSidecarScriptPath,
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

export type CursorSidecarExecuteResult = NodeSidecarExecuteResult;

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
  const emittedToolCallIds = new Set<string>();

  try {
    for await (const output of streamNodeSidecarEvents<SidecarEvent>({
      nodePath: runtime.nodePath,
      sidecarScriptPath: runtime.sidecarScriptPath ?? resolveCursorSidecarScriptPath(),
      request,
      protocolVersion: CURSOR_SIDECAR_PROTOCOL_VERSION,
      sidecarLabel: 'Cursor',
      signal,
      describeSpawnError: describeCursorSpawnError,
      executeTool: options.executeCustomTool,
      readyTimeoutMs,
      idleTimeoutMs,
      turnTimeoutMs,
      killGraceMs,
    })) {
      if (output.kind === 'error') {
        yield { type: 'error', content: output.content, done: true };
        return;
      }

      if (output.kind === 'tool_request') {
        yield {
          type: 'tool_call',
          toolCallId: output.id,
          name: output.name,
          args: output.args,
          done: false,
        };
        continue;
      }

      const chunk = mapSidecarEvent(output.event, emittedToolCallIds);
      if (!chunk) continue;

      yield chunk;
      if (chunk.type === 'error') return;
    }

    if (signal?.aborted) return;
    yield { type: 'text', text: '', done: true };
  } catch (error) {
    if (error instanceof NodeSidecarError) {
      throw new CursorSidecarError(error.message, { cause: error });
    }
    throw error;
  }
}

export class CursorSidecarError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CursorSidecarError';
  }
}
