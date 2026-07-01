import { afterEach, describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import type { CursorSidecarRequest } from '../../../../../src/services/providers/cursor/agent-runner';

const NODE_PATH = '/usr/bin/node';
const DEFAULT_REQUEST: CursorSidecarRequest = {
  apiKey: 'cursor-test-key',
  model: 'composer-2.5',
  cwd: '/workspace',
  prompt: 'Hello',
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
  kill: () => void;
};

function createMockChild(
  stdoutLines: string[],
  options: { exitCode?: number; spawnError?: Error; stderr?: string } = {}
): MockChild {
  const stderr = new PassThrough();
  const stdinStream = new PassThrough();

  let stdout = Readable.from(stdoutLines.map((line) => `${line}\n`));

  const child = Object.assign(new EventEmitter(), {
    stdin: {
      write: (chunk: string) => stdinStream.write(chunk),
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
          child.exitCode = options.exitCode ?? 0;
          child.emit('close', options.exitCode ?? 0);
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
    kill() {
      this.killed = true;
      child.exitCode = options.exitCode ?? 0;
      child.emit('close', options.exitCode ?? 0);
    },
  }) as MockChild;

  return child;
}

async function setupAgentRunnerMocks(spawnImpl: () => MockChild): Promise<void> {
  await mock.module('../../../../../src/services/providers/cursor/node-runtime', () => ({
    detectNodeRuntime: () =>
      Promise.resolve({ available: true, nodePath: NODE_PATH, version: 'v22.13.0' }),
    resetNodeRuntimeCache: () => undefined,
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
  signal?: AbortSignal
) {
  const { streamCursorAgentSidecar } = await import(
    '../../../../../src/services/providers/cursor/agent-runner'
  );
  const chunks = [];
  for await (const chunk of streamCursorAgentSidecar(request, signal)) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('streamCursorAgentSidecar', () => {
  afterEach(() => {
    mock.restore();
  });

  it('throws when Node.js runtime is unavailable', async () => {
    await mock.module('../../../../../src/services/providers/cursor/node-runtime', () => ({
      detectNodeRuntime: () =>
        Promise.resolve({ available: false, reason: 'Node.js 22.13 or newer is required.' }),
      resetNodeRuntimeCache: () => undefined,
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
});
