import { describe, expect, it } from 'bun:test';
import { createInProcessPortPair } from '@mangostudio/protocol/in-process';
import {
  HUB_BINDING_KEY_HEADER,
  HubBindingKeySchema,
  RUNTIME_ALREADY_BOUND_CLOSE_CODE,
  RUNTIME_ALREADY_BOUND_REASON,
} from '@mangostudio/shared/runtime-contract';
import Value from 'typebox/value';
import { runtimeUpgradeHeaders } from '../../../../src/services/runtime-client/connect-http-runtime';
import { hubBindingKeyFor } from '../../../../src/services/runtime-client/hub-binding-key';
import { openHubSession } from '../../../../src/services/runtime-client/hub-session';
import { isBoundElsewhere } from '../../../../src/services/runtime-client/runtime-connection-manager';

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

describe('runtimeUpgradeHeaders', () => {
  it('sends the binding key beside the bearer credential', () => {
    const binding = { userId: 'user-1', environmentId: 'lan-box' };
    expect(runtimeUpgradeHeaders('s3cret', binding)).toEqual({
      authorization: 'Bearer s3cret',
      [HUB_BINDING_KEY_HEADER]: hubBindingKeyFor(binding),
    });
  });
});

describe('a runtime that refuses the upgrade as already bound', () => {
  it('rejects the hub session with the already-bound close code', async () => {
    const ports = createInProcessPortPair();
    const opening = openHubSession(ports.a, {
      hubVersion: 'hub-test',
      hub: null,
      workspaceBinding: { userId: 'user-1', environmentId: 'lan-box-2' },
    }).catch((error: unknown) => error);
    // The runtime closes without ever announcing itself.
    ports.b.close(RUNTIME_ALREADY_BOUND_CLOSE_CODE, RUNTIME_ALREADY_BOUND_REASON);
    const refusal = await opening;
    expect(isBoundElsewhere(refusal)).toBe(true);
  });
});
