import { afterEach, describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import type {
  CursorSidecarExecuteResult,
  CursorSidecarRequest,
} from '../../../../../src/services/providers/cursor/agent-runner';
import type { StreamingChunk } from '../../../../../src/services/providers/types';

const NODE_PATH = '/usr/bin/node';
const DEFAULT_REQUEST: CursorSidecarRequest = {
  apiKey: 'cursor-test-key',
  model: 'composer-2.5',
  cwd: '/home/user/.mango/cursor-agent',
  prompt: 'Hello',
  settingSources: ['project'],
};

type MockChild = EventEmitter & {
  stdin: {
    write: (chunk: string) => boolean;
    end: () => void;
    on: PassThrough['on'];
  };
  stdout: Readable;
  stderr: PassThrough;
  killed: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: (signal?: NodeJS.Signals | number) => void;
};

function createMockChild(
  stdoutLines: string[],
  options: {
    exitCode?: number;
    signalCode?: NodeJS.Signals;
    spawnError?: Error;
    stderr?: string;
    onStdin?: (chunk: string) => void;
  } = {}
): MockChild {
  const stderr = new PassThrough();
  const stdinStream = new PassThrough();

  let stdout = Readable.from(stdoutLines.map((line) => `${line}\n`));
  let closed = false;
  let child: MockChild;
  const closeChild = () => {
    if (closed) return;
    closed = true;
    const code = options.signalCode ? null : (options.exitCode ?? 0);
    const signal = options.signalCode ?? null;
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('close', code, signal);
  };

  child = Object.assign(new EventEmitter(), {
    stdin: {
      write: (chunk: string) => {
        options.onStdin?.(chunk);
        return stdinStream.write(chunk);
      },
      end: () => {
        stdinStream.end();
        if (options.stderr) {
          stderr.write(options.stderr);
          stderr.end();
        }
        queueMicrotask(() => {
          if (options.spawnError) {
            child.emit('error', options.spawnError);
          }
          closeChild();
        });
      },
      on: (...args: Parameters<PassThrough['on']>) => stdinStream.on(...args),
    },
    get stdout() {
      return stdout;
    },
    set stdout(stream: Readable) {
      stdout = stream;
    },
    stderr,
    killed: false,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill() {
      this.killed = true;
      closeChild();
    },
  }) as MockChild;

  return child;
}

async function setupAgentRunnerMocks(spawnImpl: () => MockChild): Promise<void> {
  await mock.module('../../../../../src/services/providers/cursor/runtime-availability', () => ({
    detectCursorRuntimeAvailability: () =>
      Promise.resolve({
        available: true,
        nodePath: NODE_PATH,
        version: 'v22.13.0',
        sidecarScriptPath: '/fake/cursor-sidecar/run-agent.mjs',
      }),
  }));
  await mock.module('../../../../../src/lib/runtime-paths', () => ({
    getCursorSidecarScriptPath: () => '/fake/cursor-sidecar/run-agent.mjs',
  }));
  await mock.module('node:child_process', () => ({
    spawn: () => spawnImpl(),
  }));
}

async function collectSidecarChunks(
  request: CursorSidecarRequest = DEFAULT_REQUEST,
  signal?: AbortSignal,
  executeCustomTool?: (
    name: string,
    args: Record<string, unknown>
  ) => Promise<CursorSidecarExecuteResult>
) {
  const { streamCursorAgentSidecar } = await import(
    '../../../../../src/services/providers/cursor/agent-runner'
  );
  const chunks = [];
  for await (const chunk of streamCursorAgentSidecar(request, signal, {
    executeCustomTool,
  })) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('streamCursorAgentSidecar', () => {
  afterEach(() => {
    mock.restore();
  });

  it('throws when Node.js runtime is unavailable', async () => {
    await mock.module('../../../../../src/services/providers/cursor/runtime-availability', () => ({
      detectCursorRuntimeAvailability: () =>
        Promise.resolve({
          available: false,
          reasonCode: 'cursor.version_insufficient',
          reasonParams: { foundVersion: 'v20.0.0' },
        }),
    }));

    const { streamCursorAgentSidecar, CursorSidecarError } = await import(
      '../../../../../src/services/providers/cursor/agent-runner'
    );

    await expect(
      (async () => {
        for await (const _chunk of streamCursorAgentSidecar(DEFAULT_REQUEST)) {
          // consume
        }
      })()
    ).rejects.toBeInstanceOf(CursorSidecarError);
  });

  it('maps text and thinking NDJSON events to streaming chunks', async () => {
    await setupAgentRunnerMocks(() =>
      createMockChild([
        JSON.stringify({ type: 'text', text: 'Hello' }),
        JSON.stringify({ type: 'thinking', text: 'Planning' }),
        JSON.stringify({ type: 'done' }),
      ])
    );

    const chunks = await collectSidecarChunks();
    expect(chunks).toEqual([
      { type: 'text', text: 'Hello', done: false },
      { type: 'thinking', text: 'Planning', done: false },
      { type: 'text', text: '', done: true },
    ]);
  });

  it('maps tool_call events to streaming chunks', async () => {
    await setupAgentRunnerMocks(() =>
      createMockChild([
        JSON.stringify({
          type: 'tool_call',
          callId: 'tool-1',
          name: 'read_file',
          args: { path: 'README.md' },
        }),
        JSON.stringify({ type: 'done' }),
      ])
    );

    const chunks = await collectSidecarChunks();
    expect(chunks[0]).toMatchObject({
      type: 'tool_call',
      toolCallId: 'tool-1',
      name: 'read_file',
      args: { path: 'README.md' },
    });
  });

  it('emits one streaming chunk for two-phase Cursor tool_call events', async () => {
    await setupAgentRunnerMocks(() =>
      createMockChild([
        JSON.stringify({
          type: 'tool_call',
          callId: 'tool-1',
          name: 'bash',
          status: 'running',
          args: { command: 'echo hi' },
        }),
        JSON.stringify({
          type: 'tool_call',
          callId: 'tool-1',
          name: 'bash',
          status: 'completed',
          args: { command: 'echo hi' },
          result: 'hi',
        }),
        JSON.stringify({
          type: 'tool_call',
          callId: 'tool-1',
          name: 'bash',
          status: 'completed',
          args: { command: 'echo hi' },
          result: 'hi',
        }),
        JSON.stringify({ type: 'done' }),
      ])
    );

    const chunks = await collectSidecarChunks();
    expect(chunks.filter((chunk) => chunk.type === 'tool_call')).toEqual([
      {
        type: 'tool_call',
        toolCallId: 'tool-1',
        name: 'bash',
        args: { command: 'echo hi' },
        content: 'hi',
        done: false,
      },
    ]);
  });

  it('forwards customTools metadata to the sidecar request', async () => {
    let stdinRequest: CursorSidecarRequest | undefined;
    await setupAgentRunnerMocks(() =>
      createMockChild([JSON.stringify({ type: 'done' })], {
        onStdin: (chunk) => {
          stdinRequest = JSON.parse(chunk.trim()) as CursorSidecarRequest;
        },
      })
    );

    const customTools: NonNullable<CursorSidecarRequest['customTools']> = [
      {
        name: 'bash',
        description: 'Run Bash',
        inputSchema: { type: 'object' },
      },
      {
        name: 'read_file',
        description: 'Read a file',
        inputSchema: { type: 'object' },
      },
    ];

    await collectSidecarChunks({ ...DEFAULT_REQUEST, customTools });

    expect(stdinRequest?.customTools).toEqual(customTools);
    expect(stdinRequest?.settingSources).toEqual(['project']);
  });

  it('round-trips tool_request RPC through executeCustomTool', async () => {
    const stdinWrites: string[] = [];
    await setupAgentRunnerMocks(() =>
      createMockChild(
        [
          JSON.stringify({
            type: 'tool_request',
            id: 'mango-tool-1',
            name: 'read_file',
            args: { path: '/workspace/README.md' },
          }),
          JSON.stringify({ type: 'done' }),
        ],
        {
          onStdin: (chunk) => {
            stdinWrites.push(chunk);
          },
        }
      )
    );

    const executeCustomTool = mock(
      (name: string, args: Record<string, unknown>): Promise<CursorSidecarExecuteResult> => {
        expect(name).toBe('read_file');
        expect(args).toEqual({ path: '/workspace/README.md' });
        return Promise.resolve({ result: '{"content":"hello"}' });
      }
    );

    const chunks = await collectSidecarChunks(DEFAULT_REQUEST, undefined, executeCustomTool);

    expect(executeCustomTool).toHaveBeenCalledTimes(1);
    expect(chunks.some((chunk) => chunk.type === 'tool_call' && chunk.name === 'read_file')).toBe(
      true
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    const responseLine = stdinWrites.find((line) => line.includes('tool_response'));
    expect(responseLine).toBeDefined();
    if (!responseLine) throw new Error('expected tool_response on stdin');
    expect(JSON.parse(responseLine.trim())).toMatchObject({
      type: 'tool_response',
      id: 'mango-tool-1',
      result: '{"content":"hello"}',
    });
  });

  it('yields an error chunk and stops when the sidecar reports failure', async () => {
    await setupAgentRunnerMocks(() =>
      createMockChild([JSON.stringify({ type: 'error', content: 'Cursor agent run failed.' })])
    );

    const chunks = await collectSidecarChunks();
    expect(chunks).toEqual([{ type: 'error', content: 'Cursor agent run failed.', done: true }]);
  });

  it('yields stderr when the sidecar exits without a terminal event', async () => {
    await setupAgentRunnerMocks(() =>
      createMockChild([], { exitCode: 1, stderr: 'sidecar crashed' })
    );

    const chunks = await collectSidecarChunks();
    expect(chunks.at(-1)).toMatchObject({
      type: 'error',
      content: 'sidecar crashed',
      done: true,
    });
  });

  it('terminates the child when the abort signal fires', async () => {
    let killed = false;
    await setupAgentRunnerMocks(() => {
      const child = createMockChild([JSON.stringify({ type: 'text', text: 'slow' })]);
      const originalKill = child.kill.bind(child);
      child.kill = () => {
        killed = true;
        originalKill();
      };
      return child;
    });

    const controller = new AbortController();
    const { streamCursorAgentSidecar } = await import(
      '../../../../../src/services/providers/cursor/agent-runner'
    );

    controller.abort();
    for await (const _chunk of streamCursorAgentSidecar(DEFAULT_REQUEST, controller.signal)) {
      // drain
    }

    expect(killed).toBe(true);
  });

  it('does not hang when abort observes an already signal-closed child', async () => {
    let killed = false;
    await setupAgentRunnerMocks(() => {
      const child = createMockChild([JSON.stringify({ type: 'text', text: 'slow' })], {
        signalCode: 'SIGTERM',
      });
      const originalKill = child.kill.bind(child);
      child.kill = (signal?: NodeJS.Signals | number) => {
        killed = true;
        originalKill(signal);
      };
      return child;
    });

    const controller = new AbortController();
    const { streamCursorAgentSidecar } = await import(
      '../../../../../src/services/providers/cursor/agent-runner'
    );
    const chunks: StreamingChunk[] = [];
    const run = (async () => {
      for await (const chunk of streamCursorAgentSidecar(DEFAULT_REQUEST, controller.signal)) {
        chunks.push(chunk);
        controller.abort();
      }
      return 'completed' as const;
    })();

    const result = await Promise.race([
      run,
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 250)),
    ]);

    expect(result).toBe('completed');
    expect(killed).toBe(true);
    expect(chunks).toEqual([{ type: 'text', text: 'slow', done: false }]);
  });
});

describe('streamCursorAgentSidecar lifecycle hardening', () => {
  afterEach(() => {
    mock.restore();
  });

  it('accepts a ready handshake with the current protocol version', async () => {
    await setupAgentRunnerMocks(() =>
      createMockChild([
        JSON.stringify({ type: 'ready', protocolVersion: 1 }),
        JSON.stringify({ type: 'text', text: 'Hello' }),
        JSON.stringify({ type: 'done' }),
      ])
    );

    const chunks = await collectSidecarChunks();
    expect(chunks).toEqual([
      { type: 'text', text: 'Hello', done: false },
      { type: 'text', text: '', done: true },
    ]);
  });

  it('rejects a ready handshake with a mismatched protocol version', async () => {
    await setupAgentRunnerMocks(() =>
      createMockChild([JSON.stringify({ type: 'ready', protocolVersion: 999 })])
    );

    const { streamCursorAgentSidecar, CursorSidecarError } = await import(
      '../../../../../src/services/providers/cursor/agent-runner'
    );

    await expect(
      (async () => {
        for await (const _chunk of streamCursorAgentSidecar(DEFAULT_REQUEST)) {
          // consume
        }
      })()
    ).rejects.toThrow(CursorSidecarError);
  });

  it('fails fast with a stderr excerpt when the sidecar never starts talking', async () => {
    const silentStdout = new PassThrough();
    await setupAgentRunnerMocks(() => {
      const child = createMockChild([]);
      child.stdout = silentStdout;
      child.stderr.write('Error: Cannot find module @cursor/sdk');
      return child;
    });

    const { streamCursorAgentSidecar, CursorSidecarError } = await import(
      '../../../../../src/services/providers/cursor/agent-runner'
    );

    const consume = (async () => {
      for await (const _chunk of streamCursorAgentSidecar(DEFAULT_REQUEST, undefined, {
        readyTimeoutMs: 40,
        killGraceMs: 10,
      })) {
        // consume
      }
    })();

    await expect(consume).rejects.toThrow(CursorSidecarError);
    await expect(consume).rejects.toThrow(/failed to start within/);
    await expect(consume).rejects.toThrow(/Cannot find module @cursor\/sdk/);
  });

  it('terminates a sidecar that goes silent mid-turn with an idle error chunk', async () => {
    const stdout = new PassThrough();
    await setupAgentRunnerMocks(() => {
      const child = createMockChild([]);
      child.stdout = stdout;
      stdout.write(`${JSON.stringify({ type: 'text', text: 'partial' })}\n`);
      return child;
    });

    const chunks = await collectSidecarChunksWithOptions({
      idleTimeoutMs: 40,
      killGraceMs: 10,
    });

    expect(chunks[0]).toEqual({ type: 'text', text: 'partial', done: false });
    expect(chunks.at(-1)).toMatchObject({
      type: 'error',
      content: expect.stringContaining('no output'),
      done: true,
    });
  });

  it('enforces the hard turn ceiling even while events keep flowing', async () => {
    const stdout = new PassThrough();
    let interval: ReturnType<typeof setInterval> | undefined;
    await setupAgentRunnerMocks(() => {
      const child = createMockChild([]);
      child.stdout = stdout;
      interval = setInterval(() => {
        stdout.write(`${JSON.stringify({ type: 'text', text: 'tick' })}\n`);
      }, 10);
      return child;
    });

    try {
      const chunks = await collectSidecarChunksWithOptions({
        turnTimeoutMs: 80,
        idleTimeoutMs: 10_000,
        killGraceMs: 10,
      });

      expect(chunks.at(-1)).toMatchObject({
        type: 'error',
        content: expect.stringContaining('exceeded'),
        done: true,
      });
    } finally {
      clearInterval(interval);
    }
  });

  it('escalates SIGTERM to SIGKILL when the sidecar ignores termination', async () => {
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const stdout = new PassThrough();
    await setupAgentRunnerMocks(() => {
      const child = createMockChild([]);
      child.stdout = stdout;
      const originalKill = child.kill.bind(child);
      child.kill = (signal?: NodeJS.Signals | number) => {
        signals.push(signal);
        if (signal === 'SIGKILL') originalKill(signal);
      };
      stdout.write(`${JSON.stringify({ type: 'text', text: 'partial' })}\n`);
      return child;
    });

    const chunks = await collectSidecarChunksWithOptions({
      idleTimeoutMs: 30,
      killGraceMs: 20,
    });

    expect(chunks.at(-1)).toMatchObject({ type: 'error', done: true });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(signals).toContain('SIGTERM');
    expect(signals).toContain('SIGKILL');
  });

  it('does not fire the idle watchdog while a tool RPC is executing on the API side', async () => {
    const stdout = new PassThrough();
    await setupAgentRunnerMocks(() => {
      const child = createMockChild([], {
        onStdin: (chunkText) => {
          if (chunkText.includes('tool_response')) {
            stdout.write(`${JSON.stringify({ type: 'text', text: 'after-tool' })}\n`);
            stdout.write(`${JSON.stringify({ type: 'done' })}\n`);
            stdout.end();
          }
        },
      });
      child.stdout = stdout;
      stdout.write(
        `${JSON.stringify({ type: 'tool_request', id: 'rpc-1', name: 'slow_tool', args: {} })}\n`
      );
      return child;
    });

    const executeCustomTool = () =>
      new Promise<CursorSidecarExecuteResult>((resolve) => {
        setTimeout(() => resolve({ result: 'ok' }), 120);
      });

    const chunks = await collectSidecarChunksWithOptions(
      { idleTimeoutMs: 40, killGraceMs: 10 },
      executeCustomTool
    );

    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
    expect(chunks.some((chunk) => chunk.type === 'text' && chunk.text === 'after-tool')).toBe(true);
  });

  it('resolves cleanly when aborted while a tool RPC is still pending', async () => {
    const stdout = new PassThrough();
    let resolveTool: ((result: CursorSidecarExecuteResult) => void) | undefined;
    await setupAgentRunnerMocks(() => {
      const child = createMockChild([]);
      child.stdout = stdout;
      stdout.write(
        `${JSON.stringify({ type: 'tool_request', id: 'rpc-1', name: 'slow_tool', args: {} })}\n`
      );
      return child;
    });

    const controller = new AbortController();
    const { streamCursorAgentSidecar } = await import(
      '../../../../../src/services/providers/cursor/agent-runner'
    );

    const chunks: StreamingChunk[] = [];
    const run = (async () => {
      for await (const chunk of streamCursorAgentSidecar(DEFAULT_REQUEST, controller.signal, {
        killGraceMs: 10,
        executeCustomTool: () =>
          new Promise<CursorSidecarExecuteResult>((resolve) => {
            resolveTool = resolve;
          }),
      })) {
        chunks.push(chunk);
        controller.abort();
      }
      return 'completed' as const;
    })();

    const result = await Promise.race([
      run,
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 500)),
    ]);

    expect(result).toBe('completed');
    expect(chunks).toEqual([
      { type: 'tool_call', toolCallId: 'rpc-1', name: 'slow_tool', args: {}, done: false },
    ]);

    // The late tool response must be swallowed, not crash the process.
    resolveTool?.({ result: 'too late' });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('maps ENOENT spawn failures to the node-not-found runtime hint', async () => {
    await setupAgentRunnerMocks(() =>
      createMockChild([], {
        exitCode: -2,
        spawnError: Object.assign(new Error('spawn /usr/bin/node ENOENT'), { code: 'ENOENT' }),
      })
    );

    const chunks = await collectSidecarChunks();
    expect(chunks.at(-1)).toMatchObject({
      type: 'error',
      content: expect.stringContaining('NodeJS installed'),
      done: true,
    });
  });
});

async function collectSidecarChunksWithOptions(
  options: {
    readyTimeoutMs?: number;
    idleTimeoutMs?: number;
    turnTimeoutMs?: number;
    killGraceMs?: number;
  },
  executeCustomTool?: (
    name: string,
    args: Record<string, unknown>
  ) => Promise<CursorSidecarExecuteResult>
): Promise<StreamingChunk[]> {
  const { streamCursorAgentSidecar } = await import(
    '../../../../../src/services/providers/cursor/agent-runner'
  );
  const chunks: StreamingChunk[] = [];
  for await (const chunk of streamCursorAgentSidecar(DEFAULT_REQUEST, undefined, {
    ...options,
    executeCustomTool,
  })) {
    chunks.push(chunk);
  }
  return chunks;
}
