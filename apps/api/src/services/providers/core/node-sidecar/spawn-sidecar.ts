import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { appendBoundedTail } from '../../../../lib/bounded-tail';
import { sanitizeShellEnv } from '../../../tools/builtin/_shell-env';

/** Keep only the stderr tail so a chatty crashing sidecar cannot grow memory unbounded. */
const MAX_STDERR_CHARS = 16_384;
const STDERR_EXCERPT_MAX_CHARS = 2_000;

export interface ChildExitStatus {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface SpawnNodeSidecarProcessOptions {
  nodePath: string;
  sidecarScriptPath: string;
  envSource?: NodeJS.ProcessEnv;
  describeSpawnError?: (error: Error & { code?: string }, nodePath: string) => string;
}

export interface SpawnedNodeSidecarProcess {
  child: ChildProcessWithoutNullStreams;
  childExit: Promise<ChildExitStatus>;
  getSpawnError: () => Error | null;
  getSpawnErrorMessage: () => string | null;
  getStderr: () => string;
}

export function buildNodeSidecarEnv(
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  return sanitizeShellEnv({}, source);
}

export function spawnNodeSidecarProcess(
  options: SpawnNodeSidecarProcessOptions
): SpawnedNodeSidecarProcess {
  const child = spawn(options.nodePath, [options.sidecarScriptPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: buildNodeSidecarEnv(options.envSource),
  });
  const childExit = waitForChildExit(child);

  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = appendBoundedTail(stderr, chunk.toString('utf8'), MAX_STDERR_CHARS);
  });

  let spawnError: Error | null = null;
  child.on('error', (error: Error) => {
    spawnError = error;
  });
  child.stdin.on('error', () => {
    // Writes after the sidecar exits can emit EPIPE; swallow so it stays uncaught.
  });

  return {
    child,
    childExit,
    getSpawnError: () => spawnError,
    getSpawnErrorMessage: () =>
      spawnError
        ? (options.describeSpawnError?.(spawnError, options.nodePath) ??
          spawnError.message ??
          'Failed to start the Node sidecar.')
        : null,
    getStderr: () => stderr,
  };
}

function waitForChildExit(child: ChildProcessWithoutNullStreams): Promise<ChildExitStatus> {
  if (isNodeSidecarClosed(child)) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

export function terminateNodeSidecar(child: ChildProcessWithoutNullStreams): void {
  if (!isNodeSidecarClosed(child)) {
    child.kill('SIGTERM');
  }
}

export async function terminateNodeSidecarWithEscalation(
  child: ChildProcessWithoutNullStreams,
  childExit: Promise<ChildExitStatus>,
  graceMs: number
): Promise<void> {
  if (isNodeSidecarClosed(child)) return;
  child.kill('SIGTERM');

  const exited = await Promise.race([
    childExit.then(() => true),
    delay(Math.max(0, graceMs)).then(() => false),
  ]);
  if (!exited && !isNodeSidecarClosed(child)) {
    child.kill('SIGKILL');
  }
}

export function formatNodeSidecarExit(status: ChildExitStatus, sidecarLabel = 'Node'): string {
  if (status.signal) return `${sidecarLabel} sidecar exited with signal ${status.signal}.`;
  return `${sidecarLabel} sidecar exited with code ${status.code}.`;
}

function isNodeSidecarClosed(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

interface NodeSidecarToolRequestEvent {
  type: 'tool_request';
  id: string;
  name: string;
  args?: unknown;
}

export interface NodeSidecarExecuteResult {
  result?: unknown;
  error?: string;
  isError?: boolean;
}

export type NodeSidecarStreamOutput<SidecarEvent> =
  | { kind: 'event'; event: SidecarEvent }
  | {
      kind: 'tool_request';
      id: string;
      name: string;
      args: Record<string, unknown>;
    }
  | { kind: 'error'; content: string };

export interface StreamNodeSidecarEventsOptions {
  nodePath: string;
  sidecarScriptPath: string;
  request: unknown;
  protocolVersion: number;
  sidecarLabel: string;
  envSource?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  describeSpawnError?: (error: Error & { code?: string }, nodePath: string) => string;
  executeTool?: (name: string, args: Record<string, unknown>) => Promise<NodeSidecarExecuteResult>;
  /** Max wait for the sidecar's `ready` handshake. */
  readyTimeoutMs: number;
  /** Max stdout silence while no tool RPC is pending. */
  idleTimeoutMs: number;
  /** Hard ceiling on the whole request. */
  turnTimeoutMs: number;
  /** Grace period between SIGTERM and SIGKILL. */
  killGraceMs: number;
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

function writeToolResponse(
  stdin: NodeJS.WritableStream,
  response: { type: 'tool_response'; id: string } & NodeSidecarExecuteResult
): void {
  try {
    stdin.write(`${JSON.stringify(response)}\n`);
  } catch {
    // Sidecar may have exited; swallow EPIPE.
  }
}

function withStderrExcerpt(message: string, stderr: string): string {
  const tail = stderr.trim().slice(-STDERR_EXCERPT_MAX_CHARS);
  return tail ? `${message}\nSidecar stderr:\n${tail}` : message;
}

function parseNdjsonEvent(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asToolRequest(event: Record<string, unknown>): NodeSidecarToolRequestEvent | null {
  if (event.type !== 'tool_request') return null;
  return typeof event.id === 'string' && typeof event.name === 'string'
    ? {
        type: 'tool_request',
        id: event.id,
        name: event.name,
        args: event.args,
      }
    : null;
}

export async function* streamNodeSidecarEvents<SidecarEvent = Record<string, unknown>>(
  options: StreamNodeSidecarEventsOptions
): AsyncIterable<NodeSidecarStreamOutput<SidecarEvent>> {
  const sidecar = spawnNodeSidecarProcess({
    nodePath: options.nodePath,
    sidecarScriptPath: options.sidecarScriptPath,
    envSource: options.envSource,
    describeSpawnError: options.describeSpawnError,
  });
  const { child, childExit } = sidecar;

  const killWithEscalation = () => {
    void terminateNodeSidecarWithEscalation(child, childExit, options.killGraceMs);
  };
  const abortHandler = killWithEscalation;
  options.signal?.addEventListener('abort', abortHandler, { once: true });

  const reader = createDeadlineLineReader(child.stdout);

  try {
    if (options.signal?.aborted) {
      abortHandler();
      return;
    }

    child.stdin.write(`${JSON.stringify(options.request)}\n`);

    let sawTerminal = false;
    let sawFirstEvent = false;
    let pendingToolRpcCount = 0;
    const turnDeadline = Date.now() + options.turnTimeoutMs;

    while (true) {
      if (options.signal?.aborted) break;

      const inactivityBudget = sawFirstEvent ? options.idleTimeoutMs : options.readyTimeoutMs;
      const read = await reader.next(Math.min(inactivityBudget, turnDeadline - Date.now()));
      if (read.kind === 'eof') break;

      if (read.kind === 'timeout') {
        if (options.signal?.aborted) break;

        if (Date.now() >= turnDeadline) {
          killWithEscalation();
          yield {
            kind: 'error',
            content: `${options.sidecarLabel} sidecar request exceeded the ${Math.round(options.turnTimeoutMs / 1000)}s limit and was terminated.`,
          };
          return;
        }

        if (!sawFirstEvent) {
          killWithEscalation();
          throw new NodeSidecarError(
            withStderrExcerpt(
              `${options.sidecarLabel} sidecar failed to start within ${Math.round(options.readyTimeoutMs / 1000)}s.`,
              sidecar.getStderr()
            )
          );
        }

        // A provider tool executing on the API side legitimately silences the
        // sidecar; only enforce inactivity when nothing is in flight.
        if (pendingToolRpcCount > 0) continue;

        killWithEscalation();
        yield {
          kind: 'error',
          content: `${options.sidecarLabel} sidecar produced no output for ${Math.round(options.idleTimeoutMs / 1000)}s and was terminated.`,
        };
        return;
      }

      if (!read.line.trim()) continue;
      const event = parseNdjsonEvent(read.line);
      if (!event) continue;

      if (!sawFirstEvent) {
        sawFirstEvent = true;
        if (event.type === 'ready') {
          if (event.protocolVersion !== options.protocolVersion) {
            killWithEscalation();
            throw new NodeSidecarError(
              `The MangoStudio binary and vendored ${options.sidecarLabel} sidecar are out of sync ` +
                `(protocol ${String(event.protocolVersion ?? 'unknown')}, expected ${options.protocolVersion}). ` +
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

      const toolRequest = asToolRequest(event);
      if (toolRequest) {
        const args =
          typeof toolRequest.args === 'object' && toolRequest.args !== null
            ? (toolRequest.args as Record<string, unknown>)
            : {};

        pendingToolRpcCount += 1;
        void (async () => {
          try {
            const outcome = options.executeTool
              ? await options.executeTool(toolRequest.name, args)
              : {
                  error: `Tool "${toolRequest.name}" is not available on this provider path.`,
                  isError: true,
                };
            writeToolResponse(child.stdin, {
              type: 'tool_response',
              id: toolRequest.id,
              ...outcome,
            });
          } catch (error) {
            writeToolResponse(child.stdin, {
              type: 'tool_response',
              id: toolRequest.id,
              error: error instanceof Error ? error.message : 'Tool execution failed.',
              isError: true,
            });
          } finally {
            pendingToolRpcCount -= 1;
          }
        })();

        yield {
          kind: 'tool_request',
          id: toolRequest.id,
          name: toolRequest.name,
          args,
        };
        continue;
      }

      yield { kind: 'event', event: event as SidecarEvent };
    }

    try {
      child.stdin.end();
    } catch {
      // Sidecar may have already closed stdin.
    }

    const exitStatus = await childExit;
    if (options.signal?.aborted) return;

    const spawnErrorMessage = sidecar.getSpawnErrorMessage();
    if (spawnErrorMessage) {
      yield { kind: 'error', content: spawnErrorMessage };
      return;
    }

    if (!sawTerminal && exitStatus.code !== 0) {
      yield {
        kind: 'error',
        content:
          sidecar.getStderr().trim() || formatNodeSidecarExit(exitStatus, options.sidecarLabel),
      };
    }
  } finally {
    options.signal?.removeEventListener('abort', abortHandler);
    reader.close();
    terminateNodeSidecar(child);
  }
}

export class NodeSidecarError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NodeSidecarError';
  }
}
