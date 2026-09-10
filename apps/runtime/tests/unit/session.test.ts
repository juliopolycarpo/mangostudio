import { describe, expect, it } from 'bun:test';
import { CLOSE_CODES, Session } from '@mangostudio/protocol';
import { createInProcessPortPair } from '@mangostudio/protocol/in-process';
import {
  RUNTIME_CONTRACT_NAME,
  RUNTIME_CONTRACT_VERSION,
  type RuntimeCapabilityManifest,
} from '@mangostudio/shared/runtime-contract';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import { staticConsentSource } from '../../src/consent-source';
import {
  createRuntimeEventRelay,
  createRuntimeSession,
  type RuntimeHostDefinition,
  whenRuntimeReleased,
} from '../../src/session';
import { FakeRuntimeHandlers } from '../support/fake-runtime-handlers';

const MANIFEST: RuntimeCapabilityManifest = {
  platform: 'test',
  arch: 'test',
  pathStyle: 'posix',
  homeDir: '/home/test',
  shells: [],
  git: { available: false },
  features: {
    tools: true,
    git: false,
    probing: false,
    mcp: false,
    library: false,
    checkpoints: false,
  },
};

/**
 * A runtime whose teardown fails the way a vendor process tree that will not
 * reap does.
 *
 * @example
 * const definition = new RejectingTeardownDefinition(new Error('terminal 3 would not reap'));
 */
class RejectingTeardownDefinition implements RuntimeHostDefinition {
  readonly runtimeVersion = 'runtime-test';
  readonly manifest = () => MANIFEST;
  readonly handlers = new FakeRuntimeHandlers().map;
  readonly consent = staticConsentSource(RUNTIME_CONSENT_PRESETS.full, 'host');
  readonly isUpdateActive = () => false;
  readonly events = createRuntimeEventRelay();
  readonly onClose = () => Promise.reject(this.#failure);
  readonly #failure: Error;

  constructor(failure: Error) {
    this.#failure = failure;
  }
}

/** A hub that says hello and nothing else. */
function openFakeHub(port: Parameters<typeof createRuntimeSession>[0]): Session {
  return new Session(port, {
    peer: { name: 'fake-hub', version: 'hub-test', role: 'hub' },
    capabilities: { contracts: { [RUNTIME_CONTRACT_NAME]: RUNTIME_CONTRACT_VERSION } },
  });
}

describe('createRuntimeSession teardown', () => {
  it('logs a teardown that fails after the session ends', async () => {
    const logged: string[] = [];
    const ports = createInProcessPortPair();
    const definition = new RejectingTeardownDefinition(new Error('terminal 3 would not reap'));
    const runtime = createRuntimeSession(ports.b, definition, {
      log: (message) => logged.push(message),
    });
    const hub = openFakeHub(ports.a);
    await hub.ready;

    hub.close(CLOSE_CODES.RELEASED, 'hub stopping');
    await whenRuntimeReleased(runtime);

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('terminal 3 would not reap');
    expect(runtime.closure).toBeDefined();
  });
});
