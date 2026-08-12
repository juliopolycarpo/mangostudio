import { beforeEach, describe, expect, it } from 'bun:test';
import type {
  ExternalAgentDescriptor,
  ExternalNativeSession,
} from '@mangostudio/shared/external-agents';
import { NO_EXTERNAL_AGENT_CAPABILITIES } from '@mangostudio/shared/external-agents';
import { getDb } from '../../../../src/db/database';
import type { ExternalAgentDiscoveryService } from '../../../../src/modules/external-agents/application/external-agent-discovery';
import { createExternalIdentityIsolationRegistry } from '../../../../src/modules/external-agents/application/external-identity-isolation';
import {
  createExternalNativeSessionService,
  EXTERNAL_SESSION_ADOPTED_EVENT,
} from '../../../../src/modules/external-agents/application/external-native-sessions';
import { readAdoptionLease } from '../../../../src/modules/external-agents/infrastructure/external-session-adoption-lease-repository';
import { readContinuation } from '../../../../src/modules/external-agents/infrastructure/external-session-continuation-repository';
import {
  createFakeExternalRuntime,
  type FakeExternalRuntimeOptions,
} from '../../../support/external-agents/fake-external-runtime';
import { insertTestUser } from '../../../support/factories';

/**
 * A picker row.
 *
 * The id is unique per test on purpose: the adoption lease is keyed by the
 * *session*, not by the chat or the user, so two tests sharing one id would
 * have the first one's lease refuse the second — which is the behaviour under
 * test rather than a fixture detail to work around.
 */
function session(overrides: Partial<ExternalNativeSession> = {}): ExternalNativeSession {
  return {
    targetId: 'codex',
    nativeSessionId: `thread-${crypto.randomUUID()}`,
    title: 'Fix the flaky test',
    workspacePath: '/work/repo',
    updatedAtMs: 1_786_284_100_000,
    ...overrides,
  };
}

let userId = '';

function descriptor(overrides: Partial<ExternalAgentDescriptor> = {}): ExternalAgentDescriptor {
  return {
    targetId: 'codex',
    environmentId: 'local',
    installed: true,
    authState: 'signed-in',
    capabilities: { ...NO_EXTERNAL_AGENT_CAPABILITIES, sessionListing: true },
    supportedConfigurations: [],
    account: { label: 'ChatGPT', fingerprint: 'account-a' },
    ...overrides,
  };
}

function discoveryOf(...agents: readonly ExternalAgentDescriptor[]): ExternalAgentDiscoveryService {
  return {
    listExternalAgents: () => Promise.resolve(agents),
    resetCache: () => undefined,
  };
}

function serviceFor(
  options: {
    readonly runtime?: FakeExternalRuntimeOptions;
    readonly agents?: readonly ExternalAgentDescriptor[];
    readonly attested?: boolean;
    readonly unreachable?: boolean;
    readonly now?: () => number;
  } = {}
) {
  const runtime = createFakeExternalRuntime(options.runtime ?? {});
  const isolationRegistry = createExternalIdentityIsolationRegistry({
    sessions: { reapScope: () => Promise.resolve() },
  });
  const service = createExternalNativeSessionService({
    discovery: discoveryOf(...(options.agents ?? [descriptor()])),
    resolveRuntimeClient: () =>
      options.unreachable
        ? Promise.reject(new Error('offline'))
        : Promise.resolve(
            options.attested === false
              ? ({ ...runtime.client, manifest: {} } as typeof runtime.client)
              : runtime.client
          ),
    isolationRegistry,
    ...(options.now ? { now: options.now } : {}),
  });
  return { service, runtime };
}

beforeEach(async () => {
  const user = await insertTestUser();
  userId = user.id;
});

describe('external native session listing', () => {
  it('asks the machine the sessions live on, filtered to one folder', async () => {
    const row = session();
    const { service, runtime } = serviceFor({
      runtime: { listSessions: () => ({ sessions: [row], nextCursor: 'page-2' }) },
    });

    const listing = await service.list({
      userId,
      environmentId: 'local',
      targetId: 'codex',
      workspacePath: '/work/repo',
    });

    expect(listing).toMatchObject({ ok: true, sessions: [row], nextCursor: 'page-2' });
    expect(runtime.calls.listSessions[0]).toMatchObject({
      targetId: 'codex',
      workspacePath: '/work/repo',
    });
  });

  it('does not offer a listing on a machine that has not attested isolation', async () => {
    // A picker would show another OS user's conversation titles, which is a
    // worse disclosure than sharing a credential.
    const { service, runtime } = serviceFor({ attested: false });

    const listing = await service.list({ userId, environmentId: 'local', targetId: 'codex' });

    expect(listing).toMatchObject({ ok: false, code: 'isolation-unproven' });
    expect(runtime.calls.listSessions).toHaveLength(0);
  });

  it('says a vendor has no listing rather than answering with an empty one', async () => {
    // Claude's shape: installed, signed in, and no `sessionListing` capability,
    // because its history is an internal format the vendor will not stabilize.
    const { service, runtime } = serviceFor({
      agents: [
        descriptor({
          targetId: 'claude',
          capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
        }),
      ],
    });

    const listing = await service.list({ userId, environmentId: 'local', targetId: 'claude' });

    expect(listing).toMatchObject({ ok: false, code: 'unsupported' });
    expect(runtime.calls.listSessions).toHaveLength(0);
  });

  it('answers one way for offline, deleted and somebody else"s machines', async () => {
    const { service } = serviceFor({ unreachable: true });

    await expect(
      service.list({ userId, environmentId: 'someone-elses', targetId: 'codex' })
    ).resolves.toMatchObject({ ok: false, code: 'unreachable' });
  });
});

describe('external native session adoption', () => {
  it('creates a chat pointing at the vendor session, with a marker and no transcript', async () => {
    const row = session();
    const { service } = serviceFor({
      runtime: { listSessions: () => ({ sessions: [row] }) },
    });

    const adopted = await service.adopt({ userId, environmentId: 'local', session: row });
    expect(adopted.ok).toBe(true);
    if (!adopted.ok) return;

    expect(adopted.chat).toMatchObject({
      runner: { kind: 'external', targetId: 'codex' },
      workdir: '/work/repo',
    });

    // The native session id lives in the continuation, never in the runner the
    // client can see and set.
    await expect(readContinuation(adopted.chat.id, getDb())).resolves.toMatchObject({
      nativeSessionId: row.nativeSessionId,
      canonicalWorkspacePath: '/work/repo',
      vendorAccountFingerprint: 'account-a',
      pendingAdoption: true,
    });

    const messages = await getDb()
      .selectFrom('messages')
      .selectAll()
      .where('chatId', '=', adopted.chat.id)
      .execute();
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0]?.parts ?? '[]')).toEqual([
      { type: 'system_event', event: EXTERNAL_SESSION_ADOPTED_EVENT, detail: 'codex' },
    ]);
  });

  it('refuses a session that vanished between the listing and the click, and creates no chat', async () => {
    const { service } = serviceFor({ runtime: { listSessions: () => ({ sessions: [] }) } });

    const adopted = await service.adopt({ userId, environmentId: 'local', session: session() });

    expect(adopted).toMatchObject({ ok: false, code: 'stale' });
    await expect(
      getDb().selectFrom('chats').selectAll().where('userId', '=', userId).execute()
    ).resolves.toEqual([]);
  });

  it('refuses a session that was written to since the picker rendered', async () => {
    // Somebody is using it — quite possibly in the terminal this feature exists
    // to continue from. Joining mid-sentence is the failure, not the refusal.
    const row = session();
    const { service } = serviceFor({
      runtime: {
        listSessions: () => ({ sessions: [{ ...row, updatedAtMs: 1_786_284_999_000 }] }),
      },
    });

    await expect(
      service.adopt({ userId, environmentId: 'local', session: row })
    ).resolves.toMatchObject({ ok: false, code: 'stale' });
  });

  it('refuses a session with no folder to run in', async () => {
    const { service } = serviceFor();
    const { workspacePath: _dropped, ...withoutWorkspace } = session();

    await expect(
      service.adopt({ userId, environmentId: 'local', session: withoutWorkspace })
    ).resolves.toMatchObject({ ok: false, code: 'no-workspace' });
  });

  it('refuses a second adoption while the lease is held, and leaves no orphan chat', async () => {
    const row = session();
    const { service } = serviceFor({
      runtime: { listSessions: () => ({ sessions: [row] }) },
    });

    const first = await service.adopt({ userId, environmentId: 'local', session: row });
    expect(first.ok).toBe(true);

    const second = await service.adopt({ userId, environmentId: 'local', session: row });
    expect(second).toMatchObject({ ok: false, code: 'held' });

    const chats = await getDb()
      .selectFrom('chats')
      .selectAll()
      .where('userId', '=', userId)
      .execute();
    expect(chats).toHaveLength(1);
  });

  it('lets an expired lease be re-acquired', async () => {
    let clock = 1_000;
    const row = session();
    const { service } = serviceFor({
      runtime: { listSessions: () => ({ sessions: [row] }) },
      now: () => clock,
    });

    const first = await service.adopt({ userId, environmentId: 'local', session: row });
    expect(first.ok).toBe(true);

    // Past the TTL: a hub that died holding a lease must not make the session
    // unadoptable for good.
    clock += 24 * 60 * 60_000;
    const second = await service.adopt({ userId, environmentId: 'local', session: row });
    expect(second.ok).toBe(true);
    if (!second.ok || !first.ok) return;

    await expect(
      readAdoptionLease(
        { environmentId: 'local', targetId: 'codex', nativeSessionId: row.nativeSessionId },
        getDb()
      )
    ).resolves.toMatchObject({ chatId: second.chat.id });
  });
});
