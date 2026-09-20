/**
 * The one isolation fact that has to travel on the wire.
 *
 * A runtime can attest what it observes about itself — its uid, its credential
 * home, an intact container — and nothing at all about how many MangoStudio
 * users reach it. Only the hub sees that, so the hub says it in its `hello`,
 * and the runtime stops attesting when it hears `withdrawn`.
 *
 * Exercised over a real socket rather than in-process, because the claim exists
 * precisely for the runtimes the hub does not spawn: there is no argv to carry
 * it on, and a frozen spawn-time flag could not be revoked without restarting a
 * machine the hub does not own.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import type { Port } from '@mangostudio/protocol';
import { connectWebSocket } from '@mangostudio/protocol/ws';
import { createLocalRuntimeHost, serveRuntime } from '@mangostudio/runtime';
import type { ExternalIdentityIsolation } from '@mangostudio/shared/external-agents';
import type { HubExternalAgentIsolation } from '@mangostudio/shared/runtime-contract';
import {
  openHubSession,
  type ProtocolHubSession,
} from '../../../src/services/runtime-client/hub-session';

const ATTESTATION: ExternalIdentityIsolation = {
  method: 'os-account',
  credentialHomeFingerprint: 'sha256:isolation-claim-test',
};

const handles: Array<{ close(): void | Promise<void> }> = [];
const sessions: ProtocolHubSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) session.close();
  await Promise.allSettled(handles.splice(0).map((handle) => handle.close()));
});

/** A listening runtime that attests what a real one would, plus a hub dialled into it. */
async function connect(claim?: HubExternalAgentIsolation): Promise<ProtocolHubSession> {
  const token = 'isolation-claim-token';
  const serve = serveRuntime({
    listen: { hostname: '127.0.0.1', port: 0 },
    token,
    createHost: () =>
      createLocalRuntimeHost({
        runtimeVersion: 'isolation-claim-test',
        externalAgents: { identityIsolation: ATTESTATION },
      }),
  });
  handles.push(serve);

  const port: Port = await connectWebSocket(`ws://127.0.0.1:${serve.port}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const session = await openHubSession(port, {
    hubVersion: 'hub-isolation-test',
    ...(claim ? { externalAgentIsolation: claim } : {}),
  });
  sessions.push(session);
  return session;
}

describe('the hub isolation claim on the wire', () => {
  it('leaves the runtime attesting when the hub makes no claim', async () => {
    const session = await connect();

    expect(session.manifest.identityIsolation).toEqual(ATTESTATION);
    const health = await session.request('runtime.health', {});
    expect(health.externalAgents?.identityIsolation).toEqual(ATTESTATION);
  });

  it('leaves the runtime attesting when the hub claims a single user', async () => {
    const session = await connect('single-user');

    expect(session.manifest.identityIsolation).toEqual(ATTESTATION);
    const health = await session.request('runtime.health', {});
    expect(health.externalAgents?.identityIsolation).toEqual(ATTESTATION);
  });

  it('stops the runtime attesting once the hub withdraws the claim', async () => {
    const session = await connect('withdrawn');

    // The runtime's hello crossed this hub's, so the manifest it composed still
    // carried the attestation; the hub withholds what it has already refused.
    expect(session.manifest.identityIsolation).toBeUndefined();

    // Every answer after the handshake is the runtime's own, and it honours the
    // refusal — which is what a reconnecting peer and a `refreshManifest` read.
    const health = await session.request('runtime.health', {});
    expect(health.externalAgents?.identityIsolation).toBeUndefined();
  });
});
