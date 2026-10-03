import { expect, it } from 'bun:test';
import { NO_EXTERNAL_AGENT_CAPABILITIES } from '@mangostudio/shared/external-agents';
import { openHubSession } from '../../../../src/services/runtime-client/hub-session';
import { FakeHostileRuntimePeer } from '../../../support/mocks/fake-hostile-runtime-peer';

it('accepts an older runtime without discovery state', async () => {
  const olderRuntime = new FakeHostileRuntimePeer();
  olderRuntime.answer('external-agent.discover', {
    descriptors: [
      {
        targetId: 'claude',
        installed: false,
        authState: 'unknown',
        capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
        supportedConfigurations: [],
      },
    ],
  });
  const hub = await openHubSession(olderRuntime.hubPort, {
    workspaceBinding: null,
    hubVersion: 'hub-test',
  });
  try {
    const result = await hub.request('external-agent.discover', {
      targetIds: ['claude'],
      timeoutMs: 1000,
    });
    expect(result.descriptors).toHaveLength(1);
    expect(result.descriptors[0]?.discoveryState).toBeUndefined();
  } finally {
    hub.close();
    olderRuntime.close();
  }
});
