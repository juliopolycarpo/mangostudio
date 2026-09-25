import { describe, expect, it } from 'bun:test';
import { type Frame, Session } from '@mangostudio/protocol';
import { createInProcessPortPair } from '@mangostudio/protocol/in-process';
import {
  HUB_BINDING_KEY_CAPABILITY,
  HubBindingKeySchema,
  hubBindingKeyOf,
  RUNTIME_ALREADY_BOUND_CLOSE_CODE,
  RUNTIME_ALREADY_BOUND_REASON,
  RUNTIME_CONTRACT_NAME,
  RUNTIME_CONTRACT_VERSION,
} from '@mangostudio/shared/runtime-contract';
import Value from 'typebox/value';
import { hubBindingKeyFor } from '../../../../src/services/runtime-client/hub-binding-key';
import { openHubSession } from '../../../../src/services/runtime-client/hub-session';
import { isBoundElsewhere } from '../../../../src/services/runtime-client/runtime-connection-manager';
import { TEST_RUNTIME_MANIFEST } from '../../../support/runtime-fixture';

describe('hubBindingKeyFor', () => {
  it('derives one stable, schema-valid key per environment record', () => {
    const key = hubBindingKeyFor({ userId: 'user-1', environmentId: 'lan-box' });
    expect(Value.Check(HubBindingKeySchema, key)).toBe(true);
    expect(hubBindingKeyFor({ userId: 'user-1', environmentId: 'lan-box' })).toBe(key);
    expect(key).not.toContain('lan-box');
  });

  it('gives different records different keys, including across users', () => {
    const keys = new Set([
      hubBindingKeyFor({ userId: 'user-1', environmentId: 'lan-box' }),
      hubBindingKeyFor({ userId: 'user-1', environmentId: 'lan-box-2' }),
      hubBindingKeyFor({ userId: 'user-2', environmentId: 'lan-box' }),
      // The separator keeps `a` + `b:c` apart from `a:b` + `c`.
      hubBindingKeyFor({ userId: 'user-1\0lan', environmentId: 'box' }),
    ]);
    expect(keys.size).toBe(4);
  });
});

/** A raw runtime peer that answers the handshake with a runtime manifest. */
function runtimePeer() {
  const ports = createInProcessPortPair();
  const session = new Session(ports.b, {
    peer: { name: 'mangostudio-runtime', version: 'binding-test', role: 'runtime' },
    capabilities: {
      ...TEST_RUNTIME_MANIFEST,
      contracts: { [RUNTIME_CONTRACT_NAME]: RUNTIME_CONTRACT_VERSION },
    },
    livenessIntervalMs: false,
  });
  return { hubPort: ports.a, session };
}

describe('openHubSession binding key', () => {
  it('announces the binding key of the record it speaks for', async () => {
    const peer = runtimePeer();
    const binding = { userId: 'user-1', environmentId: 'lan-box' };
    const hub = await openHubSession(peer.hubPort, {
      hubVersion: 'hub-test',
      hub: null,
      workspaceBinding: binding,
    });
    const remote = await peer.session.ready;
    expect(hubBindingKeyOf(remote.capabilities)).toBe(hubBindingKeyFor(binding));
    hub.close();
  });

  it('announces no binding key for a connection with no real user', async () => {
    const peer = runtimePeer();
    const hub = await openHubSession(peer.hubPort, {
      hubVersion: 'hub-test',
      hub: null,
      workspaceBinding: null,
    });
    const remote = await peer.session.ready;
    expect(remote.capabilities[HUB_BINDING_KEY_CAPABILITY]).toBeUndefined();
    hub.close();
  });

  it('rejects with the already-bound close code when the runtime refuses before its hello', async () => {
    const ports = createInProcessPortPair();
    // The runtime reads the hub's hello and closes without announcing itself.
    ports.b.onFrame((frame: Frame) => {
      if (frame.type === 'hello') {
        ports.b.close(RUNTIME_ALREADY_BOUND_CLOSE_CODE, RUNTIME_ALREADY_BOUND_REASON);
      }
    });
    const refusal = await openHubSession(ports.a, {
      hubVersion: 'hub-test',
      hub: null,
      workspaceBinding: { userId: 'user-1', environmentId: 'lan-box-2' },
    }).catch((error: unknown) => error);
    expect(isBoundElsewhere(refusal)).toBe(true);
  });
});
