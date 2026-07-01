/**
 * Spawns the Node.js Cursor SDK sidecar and maps NDJSON events to StreamingChunk.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { getCursorSidecarScriptPath } from '../../../lib/runtime-paths';
import { sanitizeShellEnv } from '../../tools/builtin/_shell-env';
import type { ShellKind } from '../../tools/builtin/_shell-exec';
import type { StreamingChunk } from '../types';
import { detectCursorRuntimeAvailability } from './runtime-availability';

export interface CursorSidecarShellTool {
  kind: ShellKind;
  executable: string;
  description: string;
  inputSchema: Record<string, unknown>;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface CursorSidecarRequest {
  apiKey: string;
  model: string;
  cwd: string;
  prompt: string;
  params?: Array<{ id: string; value: string }>;
  shellTools?: CursorSidecarShellTool[];
}

interface SidecarEvent {
  type: 'text' | 'thinking' | 'tool_call' | 'error' | 'done';
  text?: string;
  content?: string;
  callId?: string;
  name?: string;
  status?: string;
  args?: unknown;
  result?: unknown;
  done?: boolean;
}

interface ChildExitStatus {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export function resolveCursorSidecarScriptPath(): string {
  return getCursorSidecarScriptPath();
}

export function buildCursorSidecarEnv(
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  return sanitizeShellEnv({}, source);
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
        content: typeof event.result === 'string' ? event.result : undefined,
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

function shouldSkipToolCallEvent(event: SidecarEvent, emittedToolCallIds: Set<string>): boolean {
  if (event.status === 'running') return true;
  const callId = typeof event.callId === 'string' ? event.callId.trim() : '';
  if (!callId) return false;
  if (emittedToolCallIds.has(callId)) return true;
  emittedToolCallIds.add(callId);
  return false;
}

export async function* streamCursorAgentSidecar(
  request: CursorSidecarRequest,
  signal?: AbortSignal
): AsyncIterable<StreamingChunk> {
  const runtime = await detectCursorRuntimeAvailability();
  if (!runtime.available || !runtime.nodePath) {
    throw new CursorSidecarError(runtime.reason ?? 'Node.js is required for Cursor SDK agents.');
  }

  const child = spawn(
    runtime.nodePath,
    [runtime.sidecarScriptPath ?? resolveCursorSidecarScriptPath()],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildCursorSidecarEnv(),
    }
  );
  const childExit = waitForChildExit(child);

  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  // Capture spawn failures (e.g. the node binary disappearing between detection
  // and spawn) so an unhandled 'error' event can't crash the whole API process.
  let spawnError: Error | null = null;
  child.on('error', (error: Error) => {
    spawnError = error;
  });
  child.stdin.on('error', () => {
    // The sidecar reads all of stdin before responding, but if it exits early
    // the write below can emit EPIPE; swallow it so it never becomes uncaught.
  });

  const abortHandler = () => {
    child.kill('SIGTERM');
  };
  signal?.addEventListener('abort', abortHandler, { once: true });

  try {
    child.stdin.write(`${JSON.stringify(request)}\n`);
    child.stdin.end();

    const rl = createInterface({ input: child.stdout });
    let sawTerminal = false;
    const emittedToolCallIds = new Set<string>();

    for await (const line of rl) {
      if (signal?.aborted) break;
      if (!line.trim()) continue;

      let event: SidecarEvent;
      try {
        event = JSON.parse(line) as SidecarEvent;
      } catch {
        continue;
      }

      if (event.type === 'done') {
        sawTerminal = true;
        break;
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

    const exitStatus = await childExit;
    if (signal?.aborted) return;

    if (spawnError) {
      yield {
        type: 'error',
        content: (spawnError as Error).message || 'Failed to start the Cursor sidecar.',
        done: true,
      };
      return;
    }
    if (!sawTerminal && exitStatus.code !== 0) {
      yield {
        type: 'error',
        content: stderr.trim() || formatCursorSidecarExit(exitStatus),
        done: true,
      };
      return;
    }

    yield { type: 'text', text: '', done: true };
  } finally {
    signal?.removeEventListener('abort', abortHandler);
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }
}

function waitForChildExit(child: ChildProcessWithoutNullStreams): Promise<ChildExitStatus> {
  if (child.exitCode !== null || child.signalCode !== null || child.killed) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

function formatCursorSidecarExit(status: ChildExitStatus): string {
  if (status.signal) return `Cursor sidecar exited with signal ${status.signal}.`;
  return `Cursor sidecar exited with code ${status.code}.`;
}

export class CursorSidecarError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CursorSidecarError';
  }
}
