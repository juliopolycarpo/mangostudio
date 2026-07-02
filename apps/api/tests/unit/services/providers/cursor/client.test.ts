import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { getCursorFallbackModels } from '../../../../../src/services/providers/cursor/model-catalog';

const NODE_PATH = '/usr/bin/node';
const SIDECAR_PATH = '/fake/cursor-sidecar/run-agent.mjs';

type RuntimeStatus =
  | {
      available: true;
      nodePath: string;
      version: string;
      sidecarScriptPath: string;
    }
  | {
      available: false;
      reasonCode:
        | 'cursor.node_not_found'
        | 'cursor.version_insufficient'
        | 'cursor.sidecar_missing';
      reasonParams?: Record<string, string>;
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
  kill: (signal?: NodeJS.Signals | number) => boolean;
};

let runtimeStatus: RuntimeStatus;
let spawnImpl: () => MockChild;
let spawnCalls: Array<{ command: string; args: string[]; options: { env?: NodeJS.ProcessEnv } }>;
let stdinWrites: string[];
let killSignals: Array<NodeJS.Signals | number | undefined>;

function createMockChild(
  stdoutLines: string[],
  options: {
    exitCode?: number;
    stderr?: string;
    closeOnEnd?: boolean;
    closeOnKill?: boolean;
  } = {}
): MockChild {
  const stderr = new PassThrough();
  const stdinStream = new PassThrough();
  const stdout = Readable.from(stdoutLines.map((line) => `${line}\n`));
  let closed = false;
  let child: MockChild;

  const closeChild = (signal?: NodeJS.Signals | null) => {
    if (closed) return;
    closed = true;
    const code = signal ? null : (options.exitCode ?? 0);
    child.exitCode = code;
    child.signalCode = signal ?? null;
    child.emit('close', code, signal ?? null);
  };

  child = Object.assign(new EventEmitter(), {
    stdin: {
      write: (chunk: string) => {
        stdinWrites.push(chunk);
        return stdinStream.write(chunk);
      },
      end: () => {
        stdinStream.end();
        if (options.stderr) {
          stderr.write(options.stderr);
          stderr.end();
        }
        if (options.closeOnEnd === false) return;
        queueMicrotask(() => closeChild());
      },
      on: (...args: Parameters<PassThrough['on']>) => stdinStream.on(...args),
    },
    stdout,
    stderr,
    killed: false,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill(signal?: NodeJS.Signals | number) {
      killSignals.push(signal);
      this.killed = true;
      if (options.closeOnKill !== false) {
        closeChild(typeof signal === 'string' ? signal : 'SIGTERM');
      }
      return true;
    },
  }) as MockChild;

  return child;
}

async function setupClientMocks(): Promise<void> {
  await mock.module('../../../../../src/services/providers/cursor/runtime-availability', () => ({
    detectCursorRuntimeAvailability: () => Promise.resolve(runtimeStatus),
  }));
  await mock.module('node:child_process', () => ({
    spawn: (command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      spawnCalls.push({ command, args, options });
      return spawnImpl();
    },
  }));
}

async function importClient() {
  await setupClientMocks();
  return import('../../../../../src/services/providers/cursor/client');
}

function lastSidecarRequest(): Record<string, unknown> {
  const requestLine = stdinWrites.at(-1);
  if (!requestLine) throw new Error('expected sidecar request');
  return JSON.parse(requestLine.trim()) as Record<string, unknown>;
}

describe('Cursor sidecar client', () => {
  beforeEach(() => {
    runtimeStatus = {
      available: true,
      nodePath: NODE_PATH,
      version: 'v22.13.0',
      sidecarScriptPath: SIDECAR_PATH,
    };
    spawnCalls = [];
    stdinWrites = [];
    killSignals = [];
    spawnImpl = () => createMockChild([JSON.stringify({ type: 'ok' })]);
  });

  afterEach(() => {
    mock.restore();
  });

  it('fetches and sorts models through the sidecar', async () => {
    spawnImpl = () =>
      createMockChild([
        JSON.stringify({
          type: 'models',
          models: [
            { id: 'zeta' },
            {
              id: 'alpha',
              parameters: [{ id: 'thinking', values: [{ value: 'high' }] }],
            },
          ],
        }),
      ]);

    const { fetchCursorModels } = await importClient();

    const models = await fetchCursorModels({ apiKey: ' cursor-test-key ' });

    expect(spawnCalls[0]).toMatchObject({
      command: NODE_PATH,
      args: [SIDECAR_PATH],
    });
    expect(lastSidecarRequest()).toEqual({
      type: 'list_models',
      apiKey: 'cursor-test-key',
    });
    expect(models.map((model) => model.modelId)).toEqual(['alpha', 'zeta']);
    expect(models[0]?.parameters).toEqual([{ id: 'thinking', values: ['high'] }]);
  });

  it('rejects empty model lists instead of returning fallbacks', async () => {
    spawnImpl = () => createMockChild([JSON.stringify({ type: 'models', models: [] })]);
    const { CursorApiError, fetchCursorModels } = await importClient();

    await expect(fetchCursorModels({ apiKey: 'cursor-empty-key' })).rejects.toBeInstanceOf(
      CursorApiError
    );
  });

  it('propagates auth failures during model discovery', async () => {
    spawnImpl = () =>
      createMockChild(
        [
          JSON.stringify({
            type: 'error',
            message: 'Cursor API key rejected',
            status: 401,
            isRetryable: false,
          }),
        ],
        { exitCode: 1 }
      );
    const { CursorApiError, fetchCursorModels } = await importClient();

    await expect(fetchCursorModels({ apiKey: 'cursor-bad-key' })).rejects.toBeInstanceOf(
      CursorApiError
    );
  });

  it('falls back to static models for retryable discovery failures', async () => {
    spawnImpl = () =>
      createMockChild(
        [
          JSON.stringify({
            type: 'error',
            message: 'Cursor temporarily unavailable',
            status: 503,
            isRetryable: true,
          }),
        ],
        { exitCode: 1 }
      );
    const { fetchCursorModels } = await importClient();

    await expect(fetchCursorModels({ apiKey: 'cursor-test-key' })).resolves.toEqual(
      getCursorFallbackModels()
    );
  });

  it('validates API keys through the sidecar', async () => {
    const { validateCursorApiKey } = await importClient();

    await validateCursorApiKey(' cursor-good-key ');

    expect(lastSidecarRequest()).toEqual({
      type: 'validate_api_key',
      apiKey: 'cursor-good-key',
    });
  });

  it('treats auth errors during key validation as CursorApiError', async () => {
    spawnImpl = () =>
      createMockChild(
        [
          JSON.stringify({
            type: 'error',
            message: 'Cursor API key rejected',
            status: 403,
            isRetryable: false,
          }),
        ],
        { exitCode: 1 }
      );
    const { CursorApiError, validateCursorApiKey } = await importClient();

    await expect(validateCursorApiKey('cursor-bad-key')).rejects.toBeInstanceOf(CursorApiError);
  });

  it('treats transient failures during key validation as unavailable', async () => {
    spawnImpl = () =>
      createMockChild(
        [
          JSON.stringify({
            type: 'error',
            message: 'Cursor temporarily unavailable',
            status: 503,
            isRetryable: true,
          }),
        ],
        { exitCode: 1 }
      );
    const { CursorValidationUnavailableError, validateCursorApiKey } = await importClient();

    await expect(validateCursorApiKey('cursor-good-key')).rejects.toBeInstanceOf(
      CursorValidationUnavailableError
    );
  });

  it('treats sidecar timeouts during key validation as unavailable', async () => {
    spawnImpl = () => createMockChild([], { closeOnEnd: false, closeOnKill: true });
    const { CursorValidationUnavailableError, validateCursorApiKey } = await importClient();

    await expect(
      validateCursorApiKey('cursor-good-key', { timeoutMs: 5, killGraceMs: 1 })
    ).rejects.toBeInstanceOf(CursorValidationUnavailableError);
    expect(killSignals).toContain('SIGTERM');
  });

  it('treats runtime unavailability during key validation as unavailable', async () => {
    runtimeStatus = {
      available: false,
      reasonCode: 'cursor.sidecar_missing',
      reasonParams: { sidecarPath: '/missing/cursor-sidecar/run-agent.mjs' },
    };
    const { CursorValidationUnavailableError, validateCursorApiKey } = await importClient();

    await expect(validateCursorApiKey('cursor-good-key')).rejects.toBeInstanceOf(
      CursorValidationUnavailableError
    );
    expect(spawnCalls).toHaveLength(0);
  });
});
