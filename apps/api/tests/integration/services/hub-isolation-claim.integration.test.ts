/**
 * The one isolation fact that has to travel on the wire.
 *
 * A runtime can attest what it observes about itself — its uid, its credential
 * home, an intact container — and nothing at all about how many MangoStudio
 * users reach it. Only the hub sees that, so the hub says it in its `hello`,
 * and the runtime stops attesting when it hears `withdrawn`.
 *
 * Exercised against a real `mangostudio-runtime serve` over a real socket,
 * because the claim exists precisely for the runtimes the hub does not spawn:
 * there is no argv to carry it on, and a frozen spawn-time flag could not be
 * revoked without restarting a machine the hub does not own. The attestation
 * is the binary's own, derived from the scratch `HOME` it runs under.
 */

import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Port } from '@mangostudio/protocol';
import { connectWebSocket } from '@mangostudio/protocol/ws';
import type { ExternalIdentityIsolation } from '@mangostudio/shared/external-agents';
import type { HubExternalAgentIsolation } from '@mangostudio/shared/runtime-contract';
import {
  openHubSession,
  type ProtocolHubSession,
} from '../../../src/services/runtime-client/hub-session';
import { resolveRustRuntimeBinary, rustRuntimeVersion } from '../../support/rust-runtime-binary';
import { startRustServe } from '../../support/rust-serve-runtime';

const binary = resolveRustRuntimeBinary();
const TOKEN = 'isolation-claim-token';

let hubVersion: string;
const cleanups: Array<() => void | Promise<void>> = [];

beforeAll(async () => {
  if (!binary.available) return;
  hubVersion = await rustRuntimeVersion(binary.path);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A listening `serve` runtime attesting its scratch credential home; returns its socket URL. */
async function startServe(): Promise<string> {
  const serve = await startRustServe(binary.path, { label: 'isolation-claim', token: TOKEN });
  cleanups.push(() => serve.close());
  return serve.wsUrl;
}

/** A hub dialled into `url`, announcing `claim` in its hello. */
async function connect(
  url: string,
  claim?: HubExternalAgentIsolation
): Promise<ProtocolHubSession> {
  const port: Port = await connectWebSocket(url, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const session = await openHubSession(port, {
    workspaceBinding: null,
    hubVersion,
    ...(claim ? { externalAgentIsolation: claim } : {}),
  });
  cleanups.push(() => session.close());
  return session;
}

/** The binary's attestation, which a claim-free hub must see; fails loudly when absent. */
function attestationOf(session: ProtocolHubSession): ExternalIdentityIsolation {
  const attested = session.manifest.identityIsolation;
  if (!attested) {
    throw new Error(
      'expected the serve runtime to attest its credential home | received: no identityIsolation'
    );
  }
  expect(attested.method).toMatch(/^(os-account|container)$/);
  return attested;
}

describe('the hub isolation claim on the wire', () => {
  it.skipIf(!binary.available)(
    'leaves the runtime attesting when the hub makes no claim',
    async () => {
      const session = await connect(await startServe());

      const attested = attestationOf(session);
      const health = await session.request('runtime.health', {});
      expect(health.externalAgents?.identityIsolation).toEqual(attested);
    },
    30_000
  );

  it.skipIf(!binary.available)(
    'leaves the runtime attesting when the hub claims a single user',
    async () => {
      const session = await connect(await startServe(), 'single-user');

      const attested = attestationOf(session);
      const health = await session.request('runtime.health', {});
      expect(health.externalAgents?.identityIsolation).toEqual(attested);
    },
    30_000
  );

  it.skipIf(!binary.available)(
    'stops the runtime attesting once the hub withdraws the claim',
    async () => {
      const url = await startServe();
      // Control: the same runtime attests to a hub that claims nothing, so the
      // absence below is the withdrawal, not a home this runtime cannot prove.
      const control = await connect(url);
      attestationOf(control);
      control.close();

      const session = await connect(url, 'withdrawn');

      // The runtime's hello crossed this hub's, so the manifest it composed still
      // carried the attestation; the hub withholds what it has already refused.
      expect(session.manifest.identityIsolation).toBeUndefined();

      // Every answer after the handshake is the runtime's own, and it honours the
      // refusal — which is what a reconnecting peer and a `refreshManifest` read.
      const health = await session.request('runtime.health', {});
      expect(health.externalAgents?.identityIsolation).toBeUndefined();
    },
    30_000
  );
});
