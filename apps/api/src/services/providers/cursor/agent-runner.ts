/**
 * Spawns the Node.js Cursor SDK sidecar and maps NDJSON events to StreamingChunk.
 * Supports bidirectional stdio RPC so MangoStudio tools execute via executeTool in the API.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { getCursorSidecarScriptPath } from '../../../lib/runtime-paths';
import { sanitizeShellEnv } from '../../tools/builtin/_shell-env';
import type { StreamingChunk } from '../types';
import { detectCursorRuntimeAvailability } from './runtime-availability';
import { resolveCursorRuntimeUnavailableMessage } from './runtime-reason';

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
}

type SidecarEvent =
  | {
      type: 'text' | 'thinking' | 'error' | 'done';
      text?: string;
      content?: string;
      done?: boolean;
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
    };

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
  stdin: ChildProcessWithoutNullStreams['stdin'],
  response: { type: 'tool_response'; id: string } & CursorSidecarExecuteResult
): void {
  try {
    stdin.write(`${JSON.stringify(response)}\n`);
  } catch {
    // Sidecar may have exited; swallow EPIPE.
  }
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

  let spawnError: Error | null = null;
  child.on('error', (error: Error) => {
    spawnError = error;
  });
  child.stdin.on('error', () => {
    // Writes after the sidecar exits can emit EPIPE; swallow so it stays uncaught.
  });

  const abortHandler = () => {
    child.kill('SIGTERM');
  };
  signal?.addEventListener('abort', abortHandler, { once: true });

  try {
    child.stdin.write(`${JSON.stringify(request)}\n`);

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

      if (event.type === 'tool_request') {
        const { id, name } = event;
        const args =
          typeof event.args === 'object' && event.args !== null
            ? (event.args as Record<string, unknown>)
            : {};

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
          }
        })();

        yield {
          type: 'tool_call',
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
