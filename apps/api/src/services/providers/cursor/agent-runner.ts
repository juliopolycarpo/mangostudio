/**
 * Spawns the Node.js Cursor SDK sidecar and maps NDJSON events to StreamingChunk.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { getCursorSidecarScriptPath } from '../../../lib/runtime-paths';
import type { StreamingChunk } from '../types';
import { detectNodeRuntime } from './node-runtime';

export interface CursorSidecarRequest {
  apiKey: string;
  model: string;
  cwd: string;
  prompt: string;
  params?: Array<{ id: string; value: string }>;
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

export function resolveCursorSidecarScriptPath(): string {
  return getCursorSidecarScriptPath();
}

function mapSidecarEvent(event: SidecarEvent): StreamingChunk | null {
  switch (event.type) {
    case 'text':
      return event.text ? { type: 'text', text: event.text, done: false } : null;
    case 'thinking':
      return event.text ? { type: 'thinking', text: event.text, done: false } : null;
    case 'tool_call':
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

export async function* streamCursorAgentSidecar(
  request: CursorSidecarRequest,
  signal?: AbortSignal
): AsyncIterable<StreamingChunk> {
  const runtime = detectNodeRuntime();
  if (!runtime.available || !runtime.nodePath) {
    throw new CursorSidecarError(runtime.reason ?? 'Node.js is required for Cursor SDK agents.');
  }

  const child = spawn(runtime.nodePath, [resolveCursorSidecarScriptPath()], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });

  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
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

    for await (const line of rl) {
      if (signal?.aborted) break;
      if (!line.trim()) continue;

      let event: SidecarEvent;
      try {
        event = JSON.parse(line) as SidecarEvent;
      } catch {
        continue;
      }

      const chunk = mapSidecarEvent(event);
      if (!chunk) continue;

      if (chunk.type === 'error') {
        sawTerminal = true;
        yield chunk;
        return;
      }

      yield chunk;

      if (event.type === 'done') {
        sawTerminal = true;
        break;
      }
    }

    const exitCode = await waitForChildExit(child);
    if (!sawTerminal && exitCode !== 0) {
      yield {
        type: 'error',
        content: stderr.trim() || `Cursor sidecar exited with code ${exitCode}.`,
        done: true,
      };
      return;
    }

    if (!sawTerminal) {
      yield { type: 'text', text: '', done: true };
    } else {
      yield { type: 'text', text: '', done: true };
    }
  } finally {
    signal?.removeEventListener('abort', abortHandler);
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }
}

function waitForChildExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    child.once('close', (code) => resolve(code));
  });
}

export class CursorSidecarError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CursorSidecarError';
  }
}
