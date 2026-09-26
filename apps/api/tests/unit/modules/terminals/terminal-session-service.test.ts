import { describe, expect, test } from 'bun:test';
import { RESERVED_ERROR_CODES, RemoteError } from '@mangostudio/protocol';
import {
  DEFAULT_TOOLCHAIN_SELECTION,
  LOCAL_ENVIRONMENT_ID,
  type ToolchainSelection,
} from '@mangostudio/shared/environments';
import { RuntimeConsentDeniedError } from '@mangostudio/shared/runtime-contract';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import { TERMINAL_SOCKET_CLOSE_CODES, type TerminalExit } from '@mangostudio/shared/terminal';
import { ChatNotFoundError } from '../../../../src/modules/chats/domain/chat-ownership';
import {
  createTerminalSessionService,
  type TerminalChatResolution,
  type TerminalConfig,
  type TerminalSessionService,
  type TerminalSessionViewer,
} from '../../../../src/modules/terminals/application/terminal-session-service';
import {
  TerminalDisabledError,
  TerminalLimitError,
  TerminalNotIsolatedError,
  TerminalSessionNotFoundError,
  TerminalUnavailableError,
} from '../../../../src/modules/terminals/domain/terminal-errors';
import { ToolExecutionTimedOutError } from '../../../../src/services/tools/execution-timeout';
import {
  FAKE_TERMINAL_MANIFEST,
  FakeTerminalRuntimeClient,
} from '../../../support/mocks/fake-terminal-runtime-client';

const ENVIRONMENT_ID = 'workshop';
const USER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';

function barrier(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function failureGate(): { promise: Promise<void>; reject: (error: Error) => void } {
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((_, fail) => {
    reject = fail;
  });
  return { promise, reject };
}

function defaultConfig(overrides: Partial<TerminalConfig> = {}): TerminalConfig {
  return {
    enabled: true,
    idleTimeoutMinutes: 30,
    maxSessionsPerUser: 8,
    scrollbackKib: 256,
    ...overrides,
  };
}

/** Named fake viewer, recording what the service pushed or closed it with. */
class RecordingViewer implements TerminalSessionViewer {
  readonly notices: Array<{ kind: string; bytes?: number }> = [];
  readonly exits: TerminalExit[] = [];
  closed: { code: number; reason: string } | null = null;

  pushNotice(notice: { kind: string; bytes?: number }): void {
    this.notices.push(notice);
  }

  endWithExit(exit: TerminalExit): void {
    this.exits.push(exit);
    this.closed = { code: TERMINAL_SOCKET_CLOSE_CODES.GONE, reason: 'Session exited' };
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
}

interface HarnessOptions {
  readonly config?: Partial<TerminalConfig>;
  readonly client?: FakeTerminalRuntimeClient;
  readonly identityAttested?: boolean;
  readonly resolveChat?: (chatId: string, userId: string) => Promise<TerminalChatResolution>;
  readonly resolveToolchain?: (
    userId: string,
    environmentId: string
  ) => Promise<ToolchainSelection>;
}

interface Harness {
  readonly service: TerminalSessionService;
  readonly client: FakeTerminalRuntimeClient;
  readonly now: { value: number };
}

function createHarness(options: HarnessOptions = {}): Harness {
  const config = defaultConfig(options.config);
  const client = options.client ?? new FakeTerminalRuntimeClient();
  const now = { value: 1_000_000 };
  const identityAttested = options.identityAttested ?? true;
  let idCounter = 0;

  const service = createTerminalSessionService({
    getConfig: () => config,
    getRuntimeClient: () => Promise.resolve(client),
    isIdentityAttested: () => identityAttested,
    resolveChat: options.resolveChat ?? (() => Promise.resolve({ ok: false, reason: 'not-found' })),
    resolveToolchain:
      options.resolveToolchain ?? (() => Promise.resolve(DEFAULT_TOOLCHAIN_SELECTION)),
    now: () => now.value,
    randomId: () => `session-${++idCounter}`,
  });

  return { service, client, now };
}

describe('terminalSessionService.open', () => {
  test('reserves a seat before resolving chat or opening the runtime PTY', async () => {
    const gate = barrier();
    const { service, client } = createHarness({
      config: { maxSessionsPerUser: 1 },
      resolveChat: async () => {
        await gate.promise;
        return { ok: true, chatId: 'chat-1', workdir: '/repo' };
      },
    });
    const first = service.open(USER_ID, { environmentId: ENVIRONMENT_ID, chatId: 'chat-1' });
    expect((await service.availability(USER_ID, ENVIRONMENT_ID)).openSessions).toBe(1);
    await expect(service.open(USER_ID, { environmentId: ENVIRONMENT_ID })).rejects.toBeInstanceOf(
      TerminalLimitError
    );
    gate.release();
    await first;
    expect(client.calls.open).toHaveLength(1);
  });

  test('an aborted late open closes its PTY and frees its reservation once', async () => {
    const gate = barrier();
    const client = new FakeTerminalRuntimeClient({ gateFirstOpen: () => gate.promise });
    const { service } = createHarness({ client, config: { maxSessionsPerUser: 1 } });
    const request = new AbortController();
    const opening = service.open(USER_ID, { environmentId: ENVIRONMENT_ID }, request.signal);
    await client.waitForCall('open');
    request.abort();
    expect((await service.availability(USER_ID, ENVIRONMENT_ID)).openSessions).toBe(1);
    await expect(service.open(USER_ID, { environmentId: ENVIRONMENT_ID })).rejects.toBeInstanceOf(
      TerminalLimitError
    );
    gate.release();
    await expect(opening).rejects.toBeDefined();
    expect((await service.availability(USER_ID, ENVIRONMENT_ID)).openSessions).toBe(0);
    expect(client.calls.close).toEqual([{ sessionId: client.calls.open[0]?.sessionId }]);
    expect(service.list(USER_ID)).toHaveLength(0);
    await service.open(USER_ID, { environmentId: ENVIRONMENT_ID });
  });

  test('abort before the runtime call frees capacity without waiting for chat resolution', async () => {
    const gate = barrier();
    const { service, client } = createHarness({
      config: { maxSessionsPerUser: 1 },
      resolveChat: async () => {
        await gate.promise;
        return { ok: true, chatId: 'chat-1', workdir: '/repo' };
      },
    });
    const request = new AbortController();
    const opening = service.open(
      USER_ID,
      { environmentId: ENVIRONMENT_ID, chatId: 'chat-1' },
      request.signal
    );
    request.abort();
    expect((await service.availability(USER_ID, ENVIRONMENT_ID)).openSessions).toBe(0);
    gate.release();
    await expect(opening).rejects.toBeDefined();
    expect(client.calls.open).toHaveLength(0);
  });

  test('open failure and runtime loss release pending ownership', async () => {
    const failed = createHarness({
      client: new FakeTerminalRuntimeClient({ failFirstOpen: new Error('open failed') }),
      config: { maxSessionsPerUser: 1 },
    });
    await expect(failed.service.open(USER_ID, { environmentId: ENVIRONMENT_ID })).rejects.toThrow(
      'open failed'
    );
    expect((await failed.service.availability(USER_ID, ENVIRONMENT_ID)).openSessions).toBe(0);

    const gate = barrier();
    const client = new FakeTerminalRuntimeClient({ gateFirstOpen: () => gate.promise });
    const { service } = createHarness({ client, config: { maxSessionsPerUser: 1 } });
    const opening = service.open(USER_ID, { environmentId: ENVIRONMENT_ID });
    await client.waitForCall('open');
    client.fireClose();
    expect((await service.availability(USER_ID, ENVIRONMENT_ID)).openSessions).toBe(0);
    gate.release();
    await expect(opening).rejects.toBeInstanceOf(TerminalUnavailableError);
    expect(client.calls.close).toHaveLength(1);
    expect(service.list(USER_ID)).toHaveLength(0);
  });

  test('shutdown cancels and closes a late open before releasing ownership', async () => {
    const gate = barrier();
    const client = new FakeTerminalRuntimeClient({ gateFirstOpen: () => gate.promise });
    const { service } = createHarness({ client, config: { maxSessionsPerUser: 1 } });
    const opening = service.open(USER_ID, { environmentId: ENVIRONMENT_ID });
    await client.waitForCall('open');
    await service.closeAll();
    gate.release();
    await expect(opening).rejects.toBeInstanceOf(TerminalUnavailableError);
    expect(client.calls.close).toEqual([{ sessionId: client.calls.open[0]?.sessionId }]);
    expect((await service.availability(USER_ID, ENVIRONMENT_ID)).openSessions).toBe(0);
    await expect(service.open(USER_ID, { environmentId: ENVIRONMENT_ID })).rejects.toBeInstanceOf(
      TerminalUnavailableError
    );
  });

  test('shutdown gives each runtime close an explicit deadline', async () => {
    const { service, client } = createHarness();
    const session = await service.open(USER_ID, { environmentId: ENVIRONMENT_ID });

    await service.closeAll();

    expect(client.calls.close).toEqual([{ sessionId: session.id }]);
    expect(client.requestOptions.close[0]?.timeoutMs).toBeGreaterThan(0);
  });

  for (const scenario of ['disconnect', 'revocation', 'shutdown'] as const) {
    test(`${scenario} cannot recreate a seat when a rejected open also fails cleanup`, async () => {
      const gate = failureGate();
      const client = new FakeTerminalRuntimeClient({
        gateFirstOpen: () => gate.promise,
        failFirstClose: new Error('close failed'),
      });
      const { service } = createHarness({ client, config: { maxSessionsPerUser: 1 } });
      const opening = service.open(USER_ID, { environmentId: ENVIRONMENT_ID });
      await client.waitForCall('open');

      if (scenario === 'disconnect') client.fireClose();
      if (scenario === 'revocation') service.revokeScope(USER_ID, ENVIRONMENT_ID);
      if (scenario === 'shutdown') await service.closeAll();
      gate.reject(new RemoteError(RESERVED_ERROR_CODES.UNAVAILABLE, 'runtime disconnected'));

      await expect(opening).rejects.toBeInstanceOf(TerminalUnavailableError);
      expect(client.calls.close).toHaveLength(1);
      if (scenario === 'revocation') {
        expect(service.list(USER_ID)).toMatchObject([
          { id: client.calls.open[0]?.sessionId, status: 'exited' },
        ]);
      } else {
        expect(service.list(USER_ID)).toHaveLength(0);
      }
      expect((await service.availability(USER_ID, ENVIRONMENT_ID)).openSessions).toBe(0);
    });
  }

  test('keeps a confirmed late PTY as a retryable exited record after revocation', async () => {
    const gate = barrier();
    let closeDenied = true;
    const client = new FakeTerminalRuntimeClient({
      gateFirstOpen: () => gate.promise,
      closeFailure: () =>
        closeDenied ? new RuntimeConsentDeniedError('shell access withdrawn') : undefined,
    });
    const { service, now } = createHarness({ client, config: { maxSessionsPerUser: 1 } });
    const opening = service.open(USER_ID, { environmentId: ENVIRONMENT_ID });
    await client.waitForCall('open');
    service.revokeScope(USER_ID, ENVIRONMENT_ID);
    gate.release();

    await expect(opening).rejects.toBeInstanceOf(TerminalUnavailableError);
    const retained = service.list(USER_ID);
    expect(retained).toMatchObject([
      {
        id: client.calls.open[0]?.sessionId,
        status: 'exited',
        exit: { exitCode: null, signal: null },
      },
    ]);
    expect((await service.availability(USER_ID, ENVIRONMENT_ID)).openSessions).toBe(0);
    expect(service.getForAttach(USER_ID, retained[0]?.id ?? '')).toBeNull();
    now.value += 31 * 60_000;
    service.reapIdle();
    await Promise.resolve();
    expect(client.calls.close).toHaveLength(2);
    expect(service.list(USER_ID)).toHaveLength(1);
    now.value += 31 * 60_000;
    service.reapIdle();
    await Promise.resolve();
    expect(client.calls.close).toHaveLength(3);
    expect(service.list(USER_ID)).toHaveLength(1);
    closeDenied = false;
    now.value += 31 * 60_000;
    service.reapIdle();
    await Promise.resolve();
    expect(client.calls.close).toHaveLength(4);
    expect(service.list(USER_ID)).toHaveLength(0);
  });

  test('keeps an ambiguous revoked open for cleanup without occupying capacity', async () => {
    const gate = barrier();
    const client = new FakeTerminalRuntimeClient({
      gateFirstOpen: () => gate.promise,
      failFirstOpen: new ToolExecutionTimedOutError('terminal.open timed out'),
      failFirstClose: new RuntimeConsentDeniedError('shell access withdrawn'),
    });
    const { service, now } = createHarness({ client, config: { maxSessionsPerUser: 1 } });
    const opening = service.open(USER_ID, { environmentId: ENVIRONMENT_ID });
    await client.waitForCall('open');
    service.revokeScope(USER_ID, ENVIRONMENT_ID);
    gate.release();

    await expect(opening).rejects.toBeInstanceOf(TerminalUnavailableError);
    const retained = service.list(USER_ID);
    expect(retained).toMatchObject([{ id: client.calls.open[0]?.sessionId, status: 'exited' }]);
    expect((await service.availability(USER_ID, ENVIRONMENT_ID)).openSessions).toBe(0);
    expect(service.getForAttach(USER_ID, retained[0]?.id ?? '')).toBeNull();
    now.value += 31 * 60_000;
    service.reapIdle();
    await Promise.resolve();
    expect(client.calls.close).toHaveLength(2);
    expect(service.list(USER_ID)).toHaveLength(0);
  });

  test('does not retain a phantom seat when consent refused the open itself', async () => {
    const client = new FakeTerminalRuntimeClient({
      failFirstOpen: new RuntimeConsentDeniedError('shell access withdrawn'),
      failFirstClose: new RuntimeConsentDeniedError('shell access withdrawn'),
    });
    const { service } = createHarness({ client, config: { maxSessionsPerUser: 1 } });

    await expect(service.open(USER_ID, { environmentId: ENVIRONMENT_ID })).rejects.toBeInstanceOf(
      TerminalUnavailableError
    );
    expect(client.calls.close).toHaveLength(1);
    expect(service.list(USER_ID)).toHaveLength(0);
    expect((await service.availability(USER_ID, ENVIRONMENT_ID)).openSessions).toBe(0);
  });

  test.each([
    new RemoteError(RESERVED_ERROR_CODES.UNAVAILABLE, 'runtime disconnected'),
    new RuntimeConsentDeniedError('shell access withdrawn'),
    new ToolExecutionTimedOutError('terminal.open timed out'),
  ])('maps an open refusal to TerminalUnavailableError: %s', async (failure) => {
    const client = new FakeTerminalRuntimeClient({ failFirstOpen: failure });
    const { service } = createHarness({ client });

    await expect(service.open(USER_ID, { environmentId: ENVIRONMENT_ID })).rejects.toBeInstanceOf(
      TerminalUnavailableError
    );
    expect(service.list(USER_ID)).toHaveLength(0);
  });

  test('reconciles detached exits at the cap without evicting running sessions', async () => {
    const { service, client } = createHarness({ config: { maxSessionsPerUser: 2 } });
    const exited = await service.open(USER_ID, { environmentId: ENVIRONMENT_ID });
    const running = await service.open(USER_ID, { environmentId: ENVIRONMENT_ID });
    client.setSessionExit(exited.id, 7);

    const availability = await service.availability(USER_ID, ENVIRONMENT_ID);
    expect(availability.openSessions).toBe(1);
    expect(service.list(USER_ID)).toEqual([
      expect.objectContaining({
        id: exited.id,
        status: 'exited',
        exit: { exitCode: 7, signal: null },
      }),
      expect.objectContaining({ id: running.id, status: 'running' }),
    ]);
    await service.open(USER_ID, { environmentId: ENVIRONMENT_ID });
  });

  test('retains a late PTY and its seat when cancellation cleanup fails', async () => {
    const gate = barrier();
    const client = new FakeTerminalRuntimeClient({
      gateFirstOpen: () => gate.promise,
      failFirstClose: new Error('close failed'),
    });
    const { service } = createHarness({ client, config: { maxSessionsPerUser: 1 } });
    const request = new AbortController();
    const opening = service.open(USER_ID, { environmentId: ENVIRONMENT_ID }, request.signal);
    await client.waitForCall('open');
    request.abort();
    gate.release();
    await expect(opening).rejects.toBeDefined();
    const retained = service.list(USER_ID);
    expect(retained).toHaveLength(1);
    expect(retained[0]?.id).toBe(client.calls.open[0]?.sessionId);
    expect((await service.availability(USER_ID, ENVIRONMENT_ID)).openSessions).toBe(1);
    await expect(service.open(USER_ID, { environmentId: ENVIRONMENT_ID })).rejects.toBeInstanceOf(
      TerminalLimitError
    );
    await service.close(USER_ID, retained[0]?.id ?? '');
    expect(client.calls.close).toHaveLength(2);
  });

  test('sets explicit deadlines for open, cleanup, and detached reconciliation', async () => {
    const client = new FakeTerminalRuntimeClient();
    const { service } = createHarness({ client });
    const session = await service.open(USER_ID, { environmentId: ENVIRONMENT_ID });
    await service.reconcile(USER_ID);
    await service.close(USER_ID, session.id);

    expect(client.requestOptions.open[0]?.timeoutMs).toBeGreaterThan(0);
    expect(client.requestOptions.list[0]?.timeoutMs).toBeGreaterThan(0);
    expect(client.requestOptions.close[0]?.timeoutMs).toBeGreaterThan(0);
  });

  test('a stale runtime list reply cannot retire a session opened after its snapshot', async () => {
    const gate = barrier();
    const client = new FakeTerminalRuntimeClient({ gateFirstList: () => gate.promise });
    const { service } = createHarness({ client, config: { maxSessionsPerUser: 2 } });
    const older = await service.open(USER_ID, { environmentId: ENVIRONMENT_ID });
    const listing = service.availability(USER_ID, ENVIRONMENT_ID);
    await service.close(USER_ID, older.id);
    const opened = await service.open(USER_ID, { environmentId: ENVIRONMENT_ID });
    gate.release();
    await listing;
    expect(service.list(USER_ID)).toEqual([
      expect.objectContaining({ id: opened.id, status: 'running' }),
    ]);
  });

  test('reconnecting while an old client open is pending does not duplicate ownership', async () => {
    const gate = barrier();
    const oldClient = new FakeTerminalRuntimeClient({ gateFirstOpen: () => gate.promise });
    const newClient = new FakeTerminalRuntimeClient();
    let currentClient = oldClient;
    let id = 0;
    const service = createTerminalSessionService({
      getConfig: () => defaultConfig({ maxSessionsPerUser: 1 }),
      getRuntimeClient: () => Promise.resolve(currentClient),
      isIdentityAttested: () => true,
      randomId: () => `reconnect-${++id}`,
    });
    const oldOpen = service.open(USER_ID, { environmentId: ENVIRONMENT_ID });
    await oldClient.waitForCall('open');
    oldClient.fireClose();
    currentClient = newClient;
    const current = await service.open(USER_ID, { environmentId: ENVIRONMENT_ID });
    gate.release();
    await expect(oldOpen).rejects.toBeDefined();
    expect(oldClient.calls.close).toEqual([{ sessionId: oldClient.calls.open[0]?.sessionId }]);
    expect(service.list(USER_ID)).toEqual([expect.objectContaining({ id: current.id })]);
    expect((await service.availability(USER_ID, ENVIRONMENT_ID)).openSessions).toBe(1);
  });
  test('refuses when terminals are disabled on the hub', async () => {
    const { service } = createHarness({ config: { enabled: false } });

    await expect(service.open(USER_ID, { environmentId: ENVIRONMENT_ID })).rejects.toBeInstanceOf(
      TerminalDisabledError
    );
  });

  test('refuses at the per-user running-session cap', async () => {
    const { service } = createHarness({ config: { maxSessionsPerUser: 1 } });

    await service.open(USER_ID, { environmentId: ENVIRONMENT_ID });
    await expect(service.open(USER_ID, { environmentId: ENVIRONMENT_ID })).rejects.toBeInstanceOf(
      TerminalLimitError
    );
    // The cap is per user: someone else can still open one.
    await expect(
      service.open(OTHER_USER_ID, { environmentId: ENVIRONMENT_ID })
    ).resolves.toBeDefined();
  });

  test('an exited session still listed does not hold a seat against the cap', async () => {
    const { service } = createHarness({ config: { maxSessionsPerUser: 1 } });
    const first = await service.open(USER_ID, { environmentId: ENVIRONMENT_ID });

    // The shell ended but the tab is still open, so the record stays listed
    // as exited until the user closes it. That record is not a running shell.
    service.recordExit(first.id, { exitCode: 0, signal: null });

    await expect(service.open(USER_ID, { environmentId: ENVIRONMENT_ID })).resolves.toMatchObject({
      status: 'running',
    });
    expect((await service.availability(USER_ID, ENVIRONMENT_ID)).openSessions).toBe(1);
  });

  test('defaults cwd to the chat workdir when the caller supplies none', async () => {
    const { service, client } = createHarness({
      resolveChat: () => Promise.resolve({ ok: true, chatId: 'chat-1', workdir: '/repo' }),
    });

    await service.open(USER_ID, { environmentId: ENVIRONMENT_ID, chatId: 'chat-1' });

    expect(client.calls.open).toHaveLength(1);
    expect(client.calls.open[0]).toMatchObject({
      cwd: '/repo',
      env: { MANGOSTUDIO_CHAT_ID: 'chat-1' },
    });
  });

  test('an explicit cwd overrides the chat workdir', async () => {
    const { service, client } = createHarness({
      resolveChat: () => Promise.resolve({ ok: true, chatId: 'chat-1', workdir: '/repo' }),
    });

    await service.open(USER_ID, {
      environmentId: ENVIRONMENT_ID,
      chatId: 'chat-1',
      cwd: '/explicit',
    });

    expect(client.calls.open[0]).toMatchObject({ cwd: '/explicit' });
  });

  test('forwards the environment toolchain the resolver returns', async () => {
    const toolchain: ToolchainSelection = { node: '/opt/custom/node/bin/node', bun: 'auto' };
    const { service, client } = createHarness({
      resolveToolchain: () => Promise.resolve(toolchain),
    });

    await service.open(USER_ID, { environmentId: ENVIRONMENT_ID });

    expect(client.calls.open[0]).toMatchObject({ toolchain });
  });

  test('rejects an unknown chat as not found', async () => {
    const { service } = createHarness({
      resolveChat: () => Promise.resolve({ ok: false }),
    });

    await expect(
      service.open(USER_ID, { environmentId: ENVIRONMENT_ID, chatId: 'ghost' })
    ).rejects.toBeInstanceOf(ChatNotFoundError);
  });

  test("rejects another user's chat with the same error as a missing one", async () => {
    const { service } = createHarness({
      // resolveChat never distinguishes missing from foreign; see its type's doc comment.
      resolveChat: () => Promise.resolve({ ok: false }),
    });

    await expect(
      service.open(USER_ID, { environmentId: ENVIRONMENT_ID, chatId: 'someone-elses' })
    ).rejects.toBeInstanceOf(ChatNotFoundError);
  });

  test('reports a runtime with no terminal support as unavailable', async () => {
    const client = new FakeTerminalRuntimeClient({
      manifest: { ...FAKE_TERMINAL_MANIFEST, terminal: false },
    });
    const { service } = createHarness({ client });

    const error = await service
      .open(USER_ID, { environmentId: ENVIRONMENT_ID })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TerminalUnavailableError);
    expect((error as TerminalUnavailableError).reason).toBe('unavailable');
  });

  test('refuses a peer that cannot close its PTY after shell consent is revoked', async () => {
    const { terminalCloseAfterRevocation: _unproven, ...oldManifest } = FAKE_TERMINAL_MANIFEST;
    const client = new FakeTerminalRuntimeClient({ manifest: oldManifest });
    const { service } = createHarness({ client });

    await expect(service.open(USER_ID, { environmentId: ENVIRONMENT_ID })).rejects.toMatchObject({
      reason: 'runtime-update-required',
      message: expect.stringContaining('needs a runtime update'),
    });
    expect(client.calls.open).toHaveLength(0);
    expect(await service.availability(USER_ID, ENVIRONMENT_ID)).toMatchObject({
      available: false,
      reason: 'runtime-update-required',
      openSessions: 0,
    });
  });

  test('offers a terminal from a peer that attests one without the install half of shell', async () => {
    // The Rust runtime reports `features.shell: false` until install is implemented,
    // while shell consent, discovered shells and the terminal handlers make `terminal` true.
    const client = new FakeTerminalRuntimeClient({
      manifest: {
        ...FAKE_TERMINAL_MANIFEST,
        features: { ...FAKE_TERMINAL_MANIFEST.features, shell: false },
        allow: { ...RUNTIME_CONSENT_PRESETS.full, shell: true },
      },
    });
    const { service } = createHarness({ client });

    expect(await service.availability(USER_ID, ENVIRONMENT_ID)).toMatchObject({
      available: true,
      shells: ['bash'],
    });
    await service.open(USER_ID, { environmentId: ENVIRONMENT_ID });
    expect(client.calls.open).toHaveLength(1);
  });

  test('keeps missing shell consent on the unavailable reason even for an older runtime', async () => {
    const { terminalCloseAfterRevocation: _unproven, ...oldManifest } = FAKE_TERMINAL_MANIFEST;
    // Hand-built: `terminal: true` with `allow.shell: false`. First-party health derives
    // `terminal` from consent, so it sends `false` instead. The hub projector still copies an
    // explicit `true` through, so the gate must refuse it.
    const client = new FakeTerminalRuntimeClient({
      manifest: {
        ...oldManifest,
        features: { ...oldManifest.features, shell: false },
        allow: { ...RUNTIME_CONSENT_PRESETS.full, shell: false },
      },
    });
    const { service } = createHarness({ client });

    expect(await service.availability(USER_ID, ENVIRONMENT_ID)).toMatchObject({
      available: false,
      reason: 'unavailable',
    });
    await expect(service.open(USER_ID, { environmentId: ENVIRONMENT_ID })).rejects.toMatchObject({
      reason: 'unavailable',
    });
  });

  test('reports a disconnected environment as unavailable', async () => {
    const service = createTerminalSessionService({
      getConfig: () => defaultConfig(),
      getRuntimeClient: () => Promise.reject(new Error('no live connection')),
      isIdentityAttested: () => true,
      resolveChat: () => Promise.resolve({ ok: false, reason: 'not-found' }),
      now: () => Date.now(),
      randomId: () => 'session-x',
    });

    const error = await service
      .open(USER_ID, { environmentId: ENVIRONMENT_ID })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TerminalUnavailableError);
    expect((error as TerminalUnavailableError).reason).toBe('disconnected');
  });

  test('refuses a Local terminal on a hub that cannot prove single-user isolation', async () => {
    const { service } = createHarness({ identityAttested: false });

    await expect(
      service.open(USER_ID, { environmentId: LOCAL_ENVIRONMENT_ID })
    ).rejects.toBeInstanceOf(TerminalNotIsolatedError);
  });

  test('allows a Local terminal once single-user isolation is attested', async () => {
    const { service } = createHarness({ identityAttested: true });

    await expect(
      service.open(USER_ID, { environmentId: LOCAL_ENVIRONMENT_ID })
    ).resolves.toBeDefined();
  });

  test('never requires isolation for a non-Local environment', async () => {
    const { service } = createHarness({ identityAttested: false });

    await expect(service.open(USER_ID, { environmentId: ENVIRONMENT_ID })).resolves.toBeDefined();
  });
});

describe('terminalSessionService runtime disconnect', () => {
  test('revocation closes a live PTY promptly and retries while cleanup is denied', async () => {
    let closeDenied = true;
    const client = new FakeTerminalRuntimeClient({
      closeFailure: () =>
        closeDenied
          ? new RuntimeConsentDeniedError('old runtime denies terminal.close')
          : undefined,
    });
    const { service } = createHarness({ client, config: { idleTimeoutMinutes: 30 } });
    const session = await service.open(USER_ID, { environmentId: ENVIRONMENT_ID });

    service.revokeScope(USER_ID, ENVIRONMENT_ID);
    expect(client.calls.close).toEqual([{ sessionId: session.id }]);
    await Promise.resolve();
    expect(service.list(USER_ID)).toMatchObject([{ id: session.id, status: 'exited' }]);
    expect((await service.availability(USER_ID, ENVIRONMENT_ID)).openSessions).toBe(0);

    service.reapIdle();
    await Promise.resolve();
    expect(client.calls.close).toHaveLength(2);
    expect(service.list(USER_ID)).toHaveLength(1);
    closeDenied = false;
    service.reapIdle();
    await Promise.resolve();
    expect(client.calls.close).toHaveLength(3);
    expect(service.list(USER_ID)).toHaveLength(0);
  });

  test('revocation tells an attached viewer why its terminal ended', async () => {
    const { service } = createHarness();
    const session = await service.open(USER_ID, { environmentId: ENVIRONMENT_ID });
    const viewer = new RecordingViewer();
    service.attachViewer(session.id, viewer);

    service.revokeScope(USER_ID, ENVIRONMENT_ID);

    const revoked: TerminalExit = { exitCode: null, signal: null, reason: 'consent-revoked' };
    expect(viewer.exits).toEqual([revoked]);
    expect(viewer.closed?.code).toBe(TERMINAL_SOCKET_CLOSE_CODES.GONE);
    expect(service.list(USER_ID)).toMatchObject([{ id: session.id, exit: revoked }]);
  });

  test('revocation keeps an exit the session already recorded', async () => {
    const { service } = createHarness();
    const session = await service.open(USER_ID, { environmentId: ENVIRONMENT_ID });
    service.attachViewer(session.id, new RecordingViewer());
    service.recordExit(session.id, { exitCode: 0, signal: null });

    service.revokeScope(USER_ID, ENVIRONMENT_ID);

    expect(service.list(USER_ID)).toMatchObject([
      { id: session.id, exit: { exitCode: 0, signal: null } },
    ]);
  });

  test('a PTY exit reported after revocation does not erase the revocation reason', async () => {
    const { service } = createHarness();
    const session = await service.open(USER_ID, { environmentId: ENVIRONMENT_ID });
    service.attachViewer(session.id, new RecordingViewer());

    service.revokeScope(USER_ID, ENVIRONMENT_ID);
    service.recordExit(session.id, { exitCode: null, signal: 'SIGHUP' });

    expect(service.list(USER_ID)).toMatchObject([
      { id: session.id, exit: { exitCode: null, signal: null, reason: 'consent-revoked' } },
    ]);
  });

  test('shell revocation ends detached sessions and releases their capacity', async () => {
    const { service } = createHarness({ config: { maxSessionsPerUser: 1 } });
    const session = await service.open(USER_ID, { environmentId: ENVIRONMENT_ID });

    service.revokeScope(USER_ID, ENVIRONMENT_ID);

    expect(service.list(USER_ID)).toMatchObject([{ id: session.id, status: 'exited' }]);
    expect((await service.availability(USER_ID, ENVIRONMENT_ID)).openSessions).toBe(0);
  });

  test('shell revocation cancels an in-flight open and closes its late PTY', async () => {
    const gate = barrier();
    const client = new FakeTerminalRuntimeClient({ gateFirstOpen: () => gate.promise });
    const { service } = createHarness({ client, config: { maxSessionsPerUser: 1 } });
    const opening = service.open(USER_ID, { environmentId: ENVIRONMENT_ID });
    await client.waitForCall('open');

    service.revokeScope(USER_ID, ENVIRONMENT_ID);
    gate.release();

    await expect(opening).rejects.toBeInstanceOf(TerminalUnavailableError);
    expect(client.calls.close).toEqual([{ sessionId: client.calls.open[0]?.sessionId }]);
    expect(service.list(USER_ID)).toHaveLength(0);
  });

  test('ends every session on a client that closes, notifying its attached viewer', async () => {
    const { service, client } = createHarness();
    const first = await service.open(USER_ID, { environmentId: ENVIRONMENT_ID });
    const second = await service.open(USER_ID, { environmentId: ENVIRONMENT_ID });
    const viewer = new RecordingViewer();
    service.attachViewer(first.id, viewer);

    client.fireClose();

    expect(service.list(USER_ID)).toHaveLength(0);
    expect(viewer.notices).toEqual([{ kind: 'runtime_disconnected' }]);
    expect(viewer.closed).not.toBeNull();
    expect(service.getForAttach(USER_ID, first.id)).toBeNull();
    expect(service.getForAttach(USER_ID, second.id)).toBeNull();
  });
});

describe('terminalSessionService.reapIdle', () => {
  test('refuses a new attach during idle close and closes a racing viewer after it', async () => {
    const gate = barrier();
    const client = new FakeTerminalRuntimeClient({ gateFirstClose: () => gate.promise });
    const { service, now } = createHarness({ client, config: { idleTimeoutMinutes: 5 } });
    const session = await service.open(USER_ID, { environmentId: ENVIRONMENT_ID });
    const alreadyAuthorized = service.getForAttach(USER_ID, session.id);
    expect(alreadyAuthorized).not.toBeNull();
    now.value += 6 * 60_000;

    const calledClose = client.waitForCall('close');
    service.reapIdle();
    await calledClose;
    expect(service.getForAttach(USER_ID, session.id)).toBeNull();
    const viewer = new RecordingViewer();
    service.attachViewer(session.id, viewer);
    gate.release();
    await Promise.resolve();
    await Promise.resolve();

    expect(viewer.closed?.code).toBe(TERMINAL_SOCKET_CLOSE_CODES.GONE);
    expect(service.list(USER_ID)).toHaveLength(0);
  });

  test('closes a viewer-less session once it has been idle past the configured timeout', async () => {
    const { service, client, now } = createHarness({ config: { idleTimeoutMinutes: 5 } });
    const session = await service.open(USER_ID, { environmentId: ENVIRONMENT_ID });

    now.value += 4 * 60_000;
    service.reapIdle();
    expect(service.list(USER_ID)).toHaveLength(1);

    now.value += 2 * 60_000;
    service.reapIdle();
    await Promise.resolve();
    expect(service.list(USER_ID)).toHaveLength(0);
    expect(client.calls.close.map((call) => call.sessionId)).toContain(session.id);
  });

  test('retains an idle session when the runtime fails to close it', async () => {
    const client = new FakeTerminalRuntimeClient({ failFirstClose: new Error('close failed') });
    const { service, now } = createHarness({
      client,
      config: { idleTimeoutMinutes: 5, maxSessionsPerUser: 1 },
    });
    await service.open(USER_ID, { environmentId: ENVIRONMENT_ID });
    now.value += 6 * 60_000;

    service.reapIdle();
    await Promise.resolve();
    expect(service.list(USER_ID)).toHaveLength(1);
    await expect(service.open(USER_ID, { environmentId: ENVIRONMENT_ID })).rejects.toBeInstanceOf(
      TerminalLimitError
    );
    service.reapIdle();
    await Promise.resolve();
    expect(service.list(USER_ID)).toHaveLength(0);
    expect(client.calls.close).toHaveLength(2);
  });

  test('never reaps a session with an attached viewer', async () => {
    const { service, now } = createHarness({ config: { idleTimeoutMinutes: 5 } });
    const session = await service.open(USER_ID, { environmentId: ENVIRONMENT_ID });
    service.attachViewer(session.id, new RecordingViewer());

    now.value += 60 * 60_000;
    service.reapIdle();

    expect(service.list(USER_ID)).toHaveLength(1);
  });
});

describe('terminalSessionService.availability', () => {
  test('reports every refusal reason the schema defines', async () => {
    const disabled = createHarness({ config: { enabled: false } });
    expect(await disabled.service.availability(USER_ID, ENVIRONMENT_ID)).toMatchObject({
      available: false,
      reason: 'disabled',
    });

    const atLimit = createHarness({ config: { maxSessionsPerUser: 1 } });
    await atLimit.service.open(USER_ID, { environmentId: ENVIRONMENT_ID });
    expect(await atLimit.service.availability(USER_ID, ENVIRONMENT_ID)).toMatchObject({
      available: false,
      reason: 'limit',
    });

    const disconnected = createTerminalSessionService({
      getConfig: () => defaultConfig(),
      getRuntimeClient: () => Promise.reject(new Error('down')),
      isIdentityAttested: () => true,
      resolveChat: () => Promise.resolve({ ok: false, reason: 'not-found' }),
      now: () => Date.now(),
      randomId: () => 'x',
    });
    expect(await disconnected.availability(USER_ID, ENVIRONMENT_ID)).toMatchObject({
      available: false,
      reason: 'disconnected',
    });

    const unavailable = createHarness({
      client: new FakeTerminalRuntimeClient({
        manifest: { ...FAKE_TERMINAL_MANIFEST, terminal: false },
      }),
    });
    expect(await unavailable.service.availability(USER_ID, ENVIRONMENT_ID)).toMatchObject({
      available: false,
      reason: 'unavailable',
    });

    const notIsolated = createHarness({ identityAttested: false });
    expect(await notIsolated.service.availability(USER_ID, LOCAL_ENVIRONMENT_ID)).toMatchObject({
      available: false,
      reason: 'not-isolated',
    });

    const available = createHarness();
    expect(await available.service.availability(USER_ID, ENVIRONMENT_ID)).toMatchObject({
      available: true,
      shells: ['bash'],
    });
  });
});

describe('terminalSessionService ownership', () => {
  test('a failed close keeps the session and its capacity slot until retry succeeds', async () => {
    const client = new FakeTerminalRuntimeClient({ failFirstClose: new Error('close failed') });
    const { service } = createHarness({ client, config: { maxSessionsPerUser: 1 } });
    const session = await service.open(USER_ID, { environmentId: ENVIRONMENT_ID });

    await expect(service.close(USER_ID, session.id)).rejects.toBeInstanceOf(
      TerminalUnavailableError
    );
    expect(service.list(USER_ID)).toHaveLength(1);
    await expect(service.open(USER_ID, { environmentId: ENVIRONMENT_ID })).rejects.toBeInstanceOf(
      TerminalLimitError
    );
    await service.close(USER_ID, session.id);
    expect(service.list(USER_ID)).toHaveLength(0);
  });

  test('getForAttach never distinguishes a missing session from one owned by someone else', async () => {
    const { service } = createHarness();
    const session = await service.open(USER_ID, { environmentId: ENVIRONMENT_ID });

    expect(service.getForAttach(OTHER_USER_ID, session.id)).toBeNull();
    expect(service.getForAttach(USER_ID, 'no-such-session')).toBeNull();
    expect(service.getForAttach(USER_ID, session.id)?.session.id).toBe(session.id);
  });

  test('rename and close require ownership', async () => {
    const { service, client } = createHarness();
    const session = await service.open(USER_ID, { environmentId: ENVIRONMENT_ID });

    expect(() => service.rename(OTHER_USER_ID, session.id, { title: 'nope' })).toThrow(
      TerminalSessionNotFoundError
    );
    await expect(service.close(OTHER_USER_ID, session.id)).rejects.toBeInstanceOf(
      TerminalSessionNotFoundError
    );

    const renamed = service.rename(USER_ID, session.id, { title: 'My shell' });
    expect(renamed.title).toBe('My shell');

    await service.close(USER_ID, session.id);
    expect(service.list(USER_ID)).toHaveLength(0);
    expect(client.calls.close.map((call) => call.sessionId)).toContain(session.id);
  });
});

describe('terminalSessionService viewer handoff', () => {
  test('a second attach replaces the first, which the caller is expected to close', async () => {
    const { service } = createHarness();
    const session = await service.open(USER_ID, { environmentId: ENVIRONMENT_ID });
    const first = new RecordingViewer();
    const second = new RecordingViewer();

    expect(service.attachViewer(session.id, first).replaced).toBeNull();
    expect(service.attachViewer(session.id, second).replaced).toBe(first);
  });

  test('detaching a stale viewer is a no-op once it has been replaced', async () => {
    const { service } = createHarness();
    const session = await service.open(USER_ID, { environmentId: ENVIRONMENT_ID });
    const first = new RecordingViewer();
    const second = new RecordingViewer();
    service.attachViewer(session.id, first);
    service.attachViewer(session.id, second);

    // The caller reads this answer to decide whether to send `terminal.detach`
    // to the runtime: a stale viewer must get "no", or its late close would
    // silence the stream the current viewer is reading.
    expect(service.detachViewer(session.id, first)).toBe(false);

    expect(service.getForAttach(USER_ID, session.id)?.session.attached).toBe(true);
    expect(service.detachViewer(session.id, second)).toBe(true);
    expect(service.getForAttach(USER_ID, session.id)?.session.attached).toBe(false);
  });

  test('a replaced viewer stops being the current one before it is detached', async () => {
    const { service } = createHarness();
    const session = await service.open(USER_ID, { environmentId: ENVIRONMENT_ID });
    const first = new RecordingViewer();
    const second = new RecordingViewer();
    service.attachViewer(session.id, first);

    expect(service.isCurrentViewer(session.id, first)).toBe(true);

    // The socket route asks this across an await, where a replaced socket's
    // `close` handler may not have run yet: the handoff itself is what has to
    // answer, so nothing speaks for a session it no longer holds.
    service.attachViewer(session.id, second);
    expect(service.isCurrentViewer(session.id, first)).toBe(false);
    expect(service.isCurrentViewer(session.id, second)).toBe(true);

    service.detachViewer(session.id, second);
    expect(service.isCurrentViewer(session.id, second)).toBe(false);
    expect(service.isCurrentViewer('no-such-session', second)).toBe(false);
  });
});
