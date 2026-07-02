/**
 * Script-level tests for sidecar/run-agent.mjs: the real script is copied into
 * a temp tree with a stub @cursor/sdk so the NDJSON protocol (ready handshake,
 * SIGTERM disposal, orphan guard, tool RPC timeouts) is exercised end to end
 * without network access or the vendored SDK.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { CURSOR_SIDECAR_PROTOCOL_VERSION } from '../../../../../src/services/providers/cursor/sidecar-process';

const SIDECAR_SOURCE = join(
  import.meta.dir,
  '../../../../../src/services/providers/cursor/sidecar/run-agent.mjs'
);
const SIDECAR_RUNTIME_SOURCE = join(
  import.meta.dir,
  '../../../../../src/services/providers/cursor/sidecar/sidecar-runtime.mjs'
);

/**
 * Stub @cursor/sdk driven by the requested model id:
 * - "stub-model": emits one assistant text event and completes.
 * - "hang": never emits, so tests can interrupt mid-run.
 * - "call-tool": invokes the first custom tool and reports its outcome as text.
 * Lifecycle markers (stub_agent_created / stub_disposed) are written with
 * writeSync so they survive an immediate process.exit.
 */
const STUB_SDK_SOURCE = `import { writeSync } from 'node:fs';

function marker(type) {
  writeSync(1, JSON.stringify({ type }) + '\\n');
}

export const Cursor = {
  models: {
    list: async () => [{ id: 'stub-model' }],
  },
};

export class Agent {
  static async create(options) {
    marker('stub_agent_created');
    return new Agent(options);
  }

  constructor(options) {
    this.options = options;
  }

  async send() {
    const options = this.options;
    return {
      async *stream() {
        const mode = options.model?.id ?? '';
        if (mode === 'hang') {
          await new Promise(() => {});
          return;
        }
        if (mode === 'call-tool') {
          const [, tool] = Object.entries(options.local?.customTools ?? {})[0] ?? [];
          let text = 'no-tool';
          if (tool) {
            try {
              const result = await tool.execute({ ping: true });
              text = 'tool-ok:' + (typeof result === 'string' ? result : JSON.stringify(result));
            } catch (error) {
              text = 'tool-error:' + error.message;
            }
          }
          yield { type: 'assistant', message: { content: [{ type: 'text', text }] } };
          return;
        }
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'stub-response' }] },
        };
      },
      async wait() {
        return { status: 'completed', id: 'stub-run' };
      },
    };
  }

  async [Symbol.asyncDispose]() {
    marker('stub_disposed');
  }
}
`;

let fixtureDir: string;
let sidecarScriptPath: string;

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'mango-sidecar-script-test-'));
  sidecarScriptPath = join(fixtureDir, 'run-agent.mjs');
  copyFileSync(SIDECAR_SOURCE, sidecarScriptPath);
  copyFileSync(SIDECAR_RUNTIME_SOURCE, join(fixtureDir, 'sidecar-runtime.mjs'));

  const sdkDir = join(fixtureDir, 'node_modules', '@cursor', 'sdk');
  mkdirSync(sdkDir, { recursive: true });
  writeFileSync(
    join(sdkDir, 'package.json'),
    JSON.stringify({
      name: '@cursor/sdk',
      version: '0.0.0-stub',
      type: 'module',
      main: 'index.mjs',
      exports: { '.': './index.mjs' },
    })
  );
  writeFileSync(join(sdkDir, 'index.mjs'), STUB_SDK_SOURCE);
});

afterAll(() => {
  rmSync(fixtureDir, { force: true, recursive: true });
});

interface SidecarHandle {
  child: ChildProcessWithoutNullStreams;
  events: Array<Record<string, unknown>>;
  waitForEvent(type: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  waitForExit(timeoutMs?: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

let activeChildren: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
  for (const child of activeChildren) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  activeChildren = [];
});

function spawnSidecar(): SidecarHandle {
  const child = spawn(process.execPath, [sidecarScriptPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '' },
  });
  activeChildren.push(child);

  const events: Array<Record<string, unknown>> = [];
  const listeners: Array<() => void> = [];
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      return;
    }
    for (const notify of [...listeners]) notify();
  });

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal }));
    }
  );

  return {
    child,
    events,
    waitForEvent(type, timeoutMs = 5_000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const match = events.find((event) => event.type === type);
          if (match) {
            clearTimeout(timer);
            listeners.splice(listeners.indexOf(check), 1);
            resolve(match);
          }
        };
        const timer = setTimeout(() => {
          listeners.splice(listeners.indexOf(check), 1);
          reject(
            new Error(`Timed out waiting for "${type}" event. Saw: ${JSON.stringify(events)}`)
          );
        }, timeoutMs);
        listeners.push(check);
        check();
      });
    },
    waitForExit(timeoutMs = 5_000) {
      return Promise.race([
        exitPromise,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Timed out waiting for sidecar exit.')),
            timeoutMs
          );
          timer.unref?.();
        }),
      ]);
    },
  };
}

function writeRequest(child: ChildProcessWithoutNullStreams, request: Record<string, unknown>) {
  child.stdin.write(`${JSON.stringify(request)}\n`);
}

const RUN_AGENT_REQUEST = {
  type: 'run_agent',
  apiKey: 'stub-key',
  model: 'stub-model',
  cwd: '/tmp',
  prompt: 'hello',
};

describe('sidecar run-agent.mjs protocol', () => {
  it('announces the ready handshake with the shared protocol version as its first event', async () => {
    const sidecar = spawnSidecar();
    writeRequest(sidecar.child, RUN_AGENT_REQUEST);
    sidecar.child.stdin.end();

    await sidecar.waitForEvent('done');
    const exit = await sidecar.waitForExit();

    expect(sidecar.events[0]).toEqual({
      type: 'ready',
      protocolVersion: CURSOR_SIDECAR_PROTOCOL_VERSION,
    });
    expect(sidecar.events).toContainEqual({ type: 'text', text: 'stub-response' });
    expect(exit.code).toBe(0);
  });

  it('exits with an error when stdin closes before a request arrives', async () => {
    const sidecar = spawnSidecar();
    sidecar.child.stdin.end();

    const errorEvent = await sidecar.waitForEvent('error');
    const exit = await sidecar.waitForExit();

    expect(errorEvent.content).toContain('before a request');
    expect(exit.code).toBe(1);
  });

  it('disposes the active agent when terminated mid-run', async () => {
    const sidecar = spawnSidecar();
    writeRequest(sidecar.child, { ...RUN_AGENT_REQUEST, model: 'hang' });

    await sidecar.waitForEvent('stub_agent_created');
    sidecar.child.kill('SIGTERM');

    const exit = await sidecar.waitForExit();
    expect(sidecar.events).toContainEqual({ type: 'stub_disposed' });
    expect(exit.code).toBe(143);
  });

  it('times out a tool RPC the parent never answers', async () => {
    const sidecar = spawnSidecar();
    writeRequest(sidecar.child, {
      ...RUN_AGENT_REQUEST,
      model: 'call-tool',
      toolRpcTimeoutMs: 100,
      customTools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }],
    });

    await sidecar.waitForEvent('tool_request');
    const textEvent = await sidecar.waitForEvent('text');
    sidecar.child.stdin.end();
    await sidecar.waitForExit();

    expect(textEvent.text).toContain('tool-error:');
    expect(textEvent.text).toContain('Tool RPC timed out after 100ms');
  });

  it('rejects pending tool RPCs when stdin closes mid-run', async () => {
    const sidecar = spawnSidecar();
    writeRequest(sidecar.child, {
      ...RUN_AGENT_REQUEST,
      model: 'call-tool',
      customTools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }],
    });

    await sidecar.waitForEvent('tool_request');
    sidecar.child.stdin.end();

    const textEvent = await sidecar.waitForEvent('text');
    await sidecar.waitForExit();

    expect(textEvent.text).toContain('tool-error:');
    expect(textEvent.text).toContain('stdin closed');
  });

  it('answers a tool RPC round trip and reports the result', async () => {
    const sidecar = spawnSidecar();
    writeRequest(sidecar.child, {
      ...RUN_AGENT_REQUEST,
      model: 'call-tool',
      customTools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }],
    });

    const toolRequest = await sidecar.waitForEvent('tool_request');
    writeRequest(sidecar.child, {
      type: 'tool_response',
      id: toolRequest.id,
      result: 'pong',
    });

    const textEvent = await sidecar.waitForEvent('text');
    sidecar.child.stdin.end();
    const exit = await sidecar.waitForExit();

    expect(textEvent.text).toBe('tool-ok:pong');
    expect(sidecar.events).toContainEqual({
      type: 'tool_result',
      id: toolRequest.id,
      name: 'echo',
      result: 'pong',
      isError: false,
    });
    expect(exit.code).toBe(0);
  });
});
