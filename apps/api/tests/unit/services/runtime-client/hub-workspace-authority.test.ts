import { afterEach, describe, expect, it } from 'bun:test';
import { RemoteError, Session } from '@mangostudio/protocol';
import { createInProcessPortPair } from '@mangostudio/protocol/in-process';
import { HUB_WORKSPACE_AUTHORIZE_METHOD } from '@mangostudio/shared/runtime-contract';
import { getDb } from '../../../../src/db/database';
import {
  type EnvironmentWorkspacePolicy,
  type HubWorkspaceBinding,
  isAuthorizedEnvironmentWorkspace,
  STAND_IN_USER_ID,
  serveHubContract,
} from '../../../../src/services/runtime-client/hub-workspace-authority';
import { insertTestChat, insertTestUser } from '../../../support/factories';

const WORKDIR = '/home/owner/project';
const ENVIRONMENT = 'devbox';

/** Stores a chat owned by `userId` on `environmentId` with `workdir`. */
async function seedChat(userId: string, environmentId: string, workdir: string): Promise<void> {
  const chat = await insertTestChat(userId);
  await getDb()
    .updateTable('chats')
    .set({ environmentId, workdir })
    .where('id', '=', chat.id)
    .execute();
}

/** A policy that records every question and answers a fixed value. */
class RecordingPolicy {
  readonly asked: Array<{ binding: HubWorkspaceBinding; canonicalPath: string }> = [];
  constructor(private readonly answer: boolean) {}
  readonly policy: EnvironmentWorkspacePolicy = (binding, canonicalPath) => {
    this.asked.push({ binding, canonicalPath });
    return Promise.resolve(this.answer);
  };
}

const sessions: Session[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.close(1000, 'test');
});

/** A hub session serving the hub contract, and the runtime session that asks it. */
async function hubAndRuntime(
  binding: HubWorkspaceBinding | null,
  policy?: EnvironmentWorkspacePolicy
): Promise<Session> {
  const ports = createInProcessPortPair();
  const peer = (role: string) => ({ name: 'hub-authority-test', version: '0.0.0', role });
  const hub = new Session(ports.a, { peer: peer('hub') });
  serveHubContract(hub, binding, policy);
  const runtime = new Session(ports.b, { peer: peer('runtime') });
  sessions.push(hub, runtime);
  await Promise.all([hub.ready, runtime.ready]);
  return runtime;
}

describe('isAuthorizedEnvironmentWorkspace', () => {
  it('authorizes exactly a stored (user, environment, workdir)', async () => {
    const owner = await insertTestUser();
    const other = await insertTestUser();
    await seedChat(owner.id, ENVIRONMENT, WORKDIR);
    const signal = new AbortController().signal;
    const ask = (userId: string, environmentId: string, path: string) =>
      isAuthorizedEnvironmentWorkspace({ userId, environmentId }, path, signal);

    expect(await ask(owner.id, ENVIRONMENT, WORKDIR)).toBe(true);
    expect(await ask(other.id, ENVIRONMENT, WORKDIR)).toBe(false);
    expect(await ask(owner.id, 'other-environment', WORKDIR)).toBe(false);
    expect(await ask(owner.id, ENVIRONMENT, `${WORKDIR}/sub`)).toBe(false);
    expect(await ask(owner.id, ENVIRONMENT, '/home/owner')).toBe(false);
  });

  it('refuses the stand-in user even when it owns a matching chat', async () => {
    await insertTestUser({ id: STAND_IN_USER_ID });
    await seedChat(STAND_IN_USER_ID, ENVIRONMENT, WORKDIR);
    const answer = await isAuthorizedEnvironmentWorkspace(
      { userId: STAND_IN_USER_ID, environmentId: ENVIRONMENT },
      WORKDIR,
      new AbortController().signal
    );
    expect(answer).toBe(false);
  });
});

describe('hub.workspace.authorize over a hub session', () => {
  const params = { canonicalPath: WORKDIR, purpose: 'external-agent' };
  const binding = { userId: 'user-1', environmentId: ENVIRONMENT };

  it('answers the policy for the connection binding, never a runtime-chosen one', async () => {
    const fake = new RecordingPolicy(true);
    const runtime = await hubAndRuntime(binding, fake.policy);
    expect(await runtime.request(HUB_WORKSPACE_AUTHORIZE_METHOD, params)).toEqual({
      authorized: true,
    });
    expect(fake.asked).toEqual([{ binding, canonicalPath: WORKDIR }]);
  });

  it('answers the real policy from the database', async () => {
    const owner = await insertTestUser();
    await seedChat(owner.id, ENVIRONMENT, WORKDIR);
    const runtime = await hubAndRuntime({ userId: owner.id, environmentId: ENVIRONMENT });
    expect(await runtime.request(HUB_WORKSPACE_AUTHORIZE_METHOD, params)).toEqual({
      authorized: true,
    });
    expect(
      await runtime.request(HUB_WORKSPACE_AUTHORIZE_METHOD, { ...params, canonicalPath: '/tmp' })
    ).toEqual({ authorized: false });
  });

  it('answers false without asking for an unbound connection or the stand-in user', async () => {
    for (const unbound of [null, { userId: STAND_IN_USER_ID, environmentId: ENVIRONMENT }]) {
      const fake = new RecordingPolicy(true);
      const runtime = await hubAndRuntime(unbound, fake.policy);
      expect(await runtime.request(HUB_WORKSPACE_AUTHORIZE_METHOD, params)).toEqual({
        authorized: false,
      });
      expect(fake.asked).toEqual([]);
    }
  });

  it('refuses invalid params with INVALID_PARAMS before the policy runs', async () => {
    const fake = new RecordingPolicy(true);
    const runtime = await hubAndRuntime(binding, fake.policy);
    for (const invalid of [
      { ...params, userId: 'someone-else' },
      { ...params, canonicalPath: '' },
      { ...params, canonicalPath: `/${'a'.repeat(4096)}` },
      { ...params, purpose: 'shell' },
      { canonicalPath: WORKDIR },
    ]) {
      const refused = await runtime.request(HUB_WORKSPACE_AUTHORIZE_METHOD, invalid).then(
        () => undefined,
        (error: unknown) => error
      );
      expect(refused).toBeInstanceOf(RemoteError);
      expect((refused as RemoteError).code).toBe('INVALID_PARAMS');
    }
    expect(fake.asked).toEqual([]);
  });
});
