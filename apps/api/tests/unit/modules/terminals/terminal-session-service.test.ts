import { describe, expect, test } from 'bun:test';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import {
  createTerminalSessionService,
  type TerminalChatResolution,
  type TerminalConfig,
  type TerminalSessionService,
  type TerminalSessionViewer,
} from '../../../../src/modules/terminals/application/terminal-session-service';
import {
  TerminalChatNotFoundError,
  TerminalDisabledError,
  TerminalLimitError,
  TerminalNotIsolatedError,
  TerminalSessionNotFoundError,
  TerminalUnavailableError,
} from '../../../../src/modules/terminals/domain/terminal-errors';
import {
  FAKE_TERMINAL_MANIFEST,
  FakeTerminalRuntimeClient,
} from '../../../support/mocks/fake-terminal-runtime-client';

const ENVIRONMENT_ID = 'workshop';
const USER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';

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
  closed: { code: number; reason: string } | null = null;

  pushNotice(notice: { kind: string; bytes?: number }): void {
    this.notices.push(notice);
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
    now: () => now.value,
    randomId: () => `session-${++idCounter}`,
  });

  return { service, client, now };
}

describe('terminalSessionService.open', () => {
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

  test('rejects an unknown chat as not found', async () => {
    const { service } = createHarness({
      resolveChat: () => Promise.resolve({ ok: false }),
    });

    await expect(
      service.open(USER_ID, { environmentId: ENVIRONMENT_ID, chatId: 'ghost' })
    ).rejects.toBeInstanceOf(TerminalChatNotFoundError);
  });

  test("rejects another user's chat with the same error as a missing one", async () => {
    const { service } = createHarness({
      // resolveChat never distinguishes missing from foreign; see its type's doc comment.
      resolveChat: () => Promise.resolve({ ok: false }),
    });

    await expect(
      service.open(USER_ID, { environmentId: ENVIRONMENT_ID, chatId: 'someone-elses' })
    ).rejects.toBeInstanceOf(TerminalChatNotFoundError);
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
  test('closes a viewer-less session once it has been idle past the configured timeout', async () => {
    const { service, client, now } = createHarness({ config: { idleTimeoutMinutes: 5 } });
    const session = await service.open(USER_ID, { environmentId: ENVIRONMENT_ID });

    now.value += 4 * 60_000;
    service.reapIdle();
    expect(service.list(USER_ID)).toHaveLength(1);

    now.value += 2 * 60_000;
    service.reapIdle();
    expect(service.list(USER_ID)).toHaveLength(0);
    expect(client.calls.close.map((call) => call.sessionId)).toContain(session.id);
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
