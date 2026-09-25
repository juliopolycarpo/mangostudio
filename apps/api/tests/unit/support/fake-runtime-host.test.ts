import { afterEach, describe, expect, it } from 'bun:test';
import {
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  RESERVED_ERROR_CODES,
  RemoteError,
} from '@mangostudio/protocol';
import {
  CONSENT_DENIED_KIND,
  type HubIdentity,
  LIBRARY_BACKUP_MISSING_KIND,
  RUNTIME_UPDATE_REFUSED,
  RuntimeServiceError,
} from '@mangostudio/shared/runtime-contract';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import {
  connectFakeRuntime,
  type FakeRuntimeConnection,
  FakeRuntimeDefinition,
  type FakeRuntimeDefinitionOptions,
  fixedConsent,
} from '../../support/fake-runtime-host';
import { TEST_RUNTIME_MANIFEST } from '../../support/runtime-fixture';

const SHELL_CALL = {
  command: 'true',
  kind: 'bash',
  timeoutMs: 1_000,
  maxOutputBytes: 1024,
} as const;
const SHELL_RESULT = {
  shell: 'bash',
  command: 'true',
  exitCode: 0,
  signal: null,
  stdout: 'ok',
  stderr: '',
  truncated: false,
  termination: { kind: 'exited' },
  durationMs: 1,
} as const;

const open: FakeRuntimeConnection[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((connection) => connection.close()));
});

async function connect(
  options: Partial<FakeRuntimeDefinitionOptions> = {}
): Promise<FakeRuntimeConnection> {
  const definition = new FakeRuntimeDefinition({
    runtimeVersion: 'runtime-test',
    manifest: TEST_RUNTIME_MANIFEST,
    consent: fixedConsent(RUNTIME_CONSENT_PRESETS.full, 'host'),
    handlers: {},
    ...options,
  });
  const connection = await connectFakeRuntime(definition, { hubVersion: 'hub-test' });
  open.push(connection);
  return connection;
}

async function rejectionOf(pending: Promise<unknown>): Promise<RemoteError> {
  const error = await pending.then(
    (value) => new Error(`expected a rejection | received: ${JSON.stringify(value)}`),
    (thrown: unknown) => thrown
  );
  if (!(error instanceof RemoteError)) {
    throw new Error(`expected a RemoteError | received: ${String(error)}`);
  }
  return error;
}

describe('fake runtime host', () => {
  it('announces the manifest and runtime version in its hello', async () => {
    const connection = await connect({ runtimeVersion: 'runtime-announced' });

    expect(connection.hub.runtimeVersion).toBe('runtime-announced');
    expect(connection.hub.manifest.platform).toBe(TEST_RUNTIME_MANIFEST.platform);
    expect(connection.hub.manifest.features).toEqual(TEST_RUNTIME_MANIFEST.features);
  });

  it('negotiates down to a runtime one wire minor behind and is still answered', async () => {
    const older = { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR - 1 };
    const connection = await connect({
      protocol: older,
      handlers: { 'shell.run': () => SHELL_RESULT },
    });

    expect(connection.hub.effectiveMinor).toBe(older.minor);
    expect(await connection.hub.request('shell.run', SHELL_CALL)).toEqual(SHELL_RESULT);
  });

  it("runs at this SDK's minor against a runtime on the same one", async () => {
    const connection = await connect();

    expect(connection.hub.effectiveMinor).toBe(PROTOCOL_MINOR);
  });

  it('answers a named method and names the fixture when an unnamed one is called', async () => {
    const connection = await connect({ handlers: { 'shell.run': () => SHELL_RESULT } });

    expect(await connection.hub.request('shell.run', SHELL_CALL)).toEqual(SHELL_RESULT);
    const error = await rejectionOf(
      connection.hub.request('git.exec', { args: ['status'], cwd: '/repo' })
    );
    expect(error.code).toBe(RESERVED_ERROR_CODES.INTERNAL);
    expect(error.message).toContain('"git.exec" has no handler in this fixture');
    expect(error.message).toContain('expected one of shell.run');
  });

  it('refuses parameters the contract refuses before the handler runs', async () => {
    let ran = false;
    const connection = await connect({
      handlers: {
        'shell.run': () => {
          ran = true;
          return SHELL_RESULT;
        },
      },
    });

    const error = await rejectionOf(connection.hub.request('shell.run', {} as never));

    expect(error.code).toBe(RESERVED_ERROR_CODES.INVALID_PARAMS);
    expect(ran).toBe(false);
  });

  it('refuses a result the contract does not describe', async () => {
    const connection = await connect({ handlers: { 'shell.run': () => ({ exitCode: 'zero' }) } });

    const error = await rejectionOf(connection.hub.request('shell.run', SHELL_CALL));

    expect(error.code).toBe(RESERVED_ERROR_CODES.INTERNAL);
    expect(error.message).toContain('Result of "shell.run" does not match the contract');
  });

  it('refuses a method whose capability the consent source withholds', async () => {
    let ran = false;
    const connection = await connect({
      consent: fixedConsent({ ...RUNTIME_CONSENT_PRESETS.full, shell: false }, 'wsl'),
      handlers: {
        'shell.run': () => {
          ran = true;
          return SHELL_RESULT;
        },
      },
    });

    const error = await rejectionOf(connection.hub.request('shell.run', SHELL_CALL));

    expect(error.code).toBe(RESERVED_ERROR_CODES.DENIED);
    expect(error.details).toEqual({
      kind: CONSENT_DENIED_KIND,
      method: 'shell.run',
      missing: ['shell'],
      slot: 'wsl',
      capability: 'shell',
    });
    expect(error.message).toContain('mangostudio-runtime setup --slot wsl');
    expect(ran).toBe(false);
  });

  it('also requires fsRead and checkpoints for a snapshot-capturing mutation', async () => {
    const connection = await connect({
      consent: fixedConsent(
        { ...RUNTIME_CONSENT_PRESETS.full, fsRead: false, checkpoints: false },
        'host'
      ),
      handlers: { 'fs.write-file': () => ({ bytesWritten: 1 }) },
    });

    const error = await rejectionOf(
      connection.hub.request('fs.write-file', {
        chatId: 'c1',
        inputPath: 'a.txt',
        resolvedPath: '/workspace/a.txt',
        content: 'a',
        captureSnapshot: true,
      } as never)
    );

    expect(error.code).toBe(RESERVED_ERROR_CODES.DENIED);
    expect(error.details).toMatchObject({ missing: ['fsRead', 'checkpoints'] });
  });

  it('flattens a thrown service error onto the wire with its kind and data', async () => {
    const connection = await connect({
      handlers: {
        'library.undo': () => {
          throw new RuntimeServiceError(LIBRARY_BACKUP_MISSING_KIND, 'that set is gone', {
            backupId: 'b1',
          });
        },
      },
    });

    const missing = await rejectionOf(
      connection.hub.request('library.undo', { backupRoot: '/b', backupId: 'b1' } as never)
    );
    expect(missing.code).toBe(RESERVED_ERROR_CODES.INTERNAL);
    expect(missing.message).toBe('that set is gone');
    expect(missing.details).toEqual({ kind: LIBRARY_BACKUP_MISSING_KIND, backupId: 'b1' });
  });

  it('sends a refused update as RUNTIME_UPDATE_REFUSED', async () => {
    const connection = await connect({
      handlers: {
        'runtime.health': () => {
          throw new RuntimeServiceError('runtime_update_refused', 'busy', { reason: 'test' });
        },
      },
    });

    const error = await rejectionOf(connection.hub.request('runtime.health', {}));

    expect(error.code).toBe(RUNTIME_UPDATE_REFUSED);
    expect(error.details).toEqual({ kind: 'runtime_update_refused', reason: 'test' });
  });

  it('refuses a value the byte codec cannot carry', async () => {
    const connection = await connect({
      handlers: { 'shell.run': () => ({ ...SHELL_RESULT, stdout: 1n }) },
    });

    await expect(connection.hub.request('shell.run', SHELL_CALL)).rejects.toThrow();
  });

  it('delivers an emitted event once the session is bound, and refuses one after close', async () => {
    const definition = new FakeRuntimeDefinition({
      runtimeVersion: 'runtime-test',
      manifest: TEST_RUNTIME_MANIFEST,
      consent: fixedConsent(RUNTIME_CONSENT_PRESETS.full, 'host'),
      handlers: {},
    });
    const connection = await connectFakeRuntime(definition, { hubVersion: 'hub-test' });
    const received = new Promise<unknown>((resolve) => {
      connection.hub.onEvent((frame) => resolve(frame.payload));
    });

    expect(definition.emit({ topic: 'runtime.heartbeat', payload: { at: 1 } })).toBe(true);
    expect(await received).toEqual({ at: 1 });

    await connection.close();
    expect(definition.emit({ topic: 'runtime.heartbeat', payload: { at: 2 } })).toBe(false);
  });

  it('hands the hub identity from the hello to the audit recorder', async () => {
    const announced: (HubIdentity | null)[] = [];
    const identified = Promise.withResolvers<void>();
    await connect({
      audit: {
        setHub: (hub) => {
          announced.push(hub);
          if (hub) identified.resolve();
        },
      },
    });

    await identified.promise;
    expect(announced[0]).toBeNull();
    expect(announced[1]).toMatchObject({ host: expect.any(String), user: expect.any(String) });
  });
});
