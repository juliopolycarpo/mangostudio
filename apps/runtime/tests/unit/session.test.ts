import { describe, expect, it } from 'bun:test';
import { CLOSE_CODES, Session } from '@mangostudio/protocol';
import { createInProcessPortPair } from '@mangostudio/protocol/in-process';
import {
  RUNTIME_CONTRACT_NAME,
  RUNTIME_CONTRACT_VERSION,
  type RuntimeCapabilityManifest,
} from '@mangostudio/shared/runtime-contract';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import type { RuntimeAuditSink } from '../../src/audit-log';
import { staticConsentSource } from '../../src/consent-source';
import {
  createRuntimeEventRelay,
  createRuntimeSession,
  type RuntimeHostDefinition,
  whenRuntimeReleased,
} from '../../src/session';
import { FakeAuditSink } from '../support/fake-audit-sink';
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

/** A runtime whose handlers answer `{ ok: true }` to everything, contract or not. */
class AcknowledgingDefinition implements RuntimeHostDefinition {
  readonly runtimeVersion = 'runtime-test';
  readonly manifest = () => MANIFEST;
  readonly handlers = new FakeRuntimeHandlers().map;
  readonly consent = staticConsentSource(RUNTIME_CONSENT_PRESETS.full, 'host');
  readonly isUpdateActive = () => false;
  readonly events = createRuntimeEventRelay();
  readonly onClose = () => undefined;
  readonly audit: RuntimeAuditSink | undefined;

  constructor(audit?: RuntimeAuditSink) {
    this.audit = audit;
  }
}

/** A hub that says hello and nothing else. */
function openFakeHub(port: Parameters<typeof createRuntimeSession>[0]): Session {
  return new Session(port, {
    peer: { name: 'fake-hub', version: 'hub-test', role: 'hub' },
    capabilities: { contracts: { [RUNTIME_CONTRACT_NAME]: RUNTIME_CONTRACT_VERSION } },
  });
}

/**
 * The check is wired here, not only decided in `loadRuntimeConfig`: nothing
 * else in the tree would notice `checkResults` no longer wrapping the handlers,
 * and the whole point of validating results is that a runtime generated from
 * the same catalog in another language never sees the drift its TypeScript
 * sibling shipped.
 *
 * `runtime.health` because it needs no capability, and the fake answers it —
 * like every other method — with `{ ok: true }`, which is not a health report.
 */
describe('createRuntimeSession result validation', () => {
  it('refuses a handler result the contract does not describe', async () => {
    const ports = createInProcessPortPair();
    const runtime = createRuntimeSession(ports.b, new AcknowledgingDefinition());
    const hub = openFakeHub(ports.a);
    await hub.ready;

    await expect(hub.request('runtime.health', {})).rejects.toThrow(
      /Result of "runtime.health" does not match the contract/
    );

    hub.close(CLOSE_CODES.RELEASED, 'hub stopping');
    await whenRuntimeReleased(runtime);
  });

  it('delivers the same result when the caller turns the check off', async () => {
    const ports = createInProcessPortPair();
    const runtime = createRuntimeSession(ports.b, new AcknowledgingDefinition(), {
      validateResults: false,
    });
    const hub = openFakeHub(ports.a);
    await hub.ready;

    expect(await hub.request('runtime.health', {})).toEqual({ ok: true });

    hub.close(CLOSE_CODES.RELEASED, 'hub stopping');
    await whenRuntimeReleased(runtime);
  });

  // The hub is told `INTERNAL`; the machine's own receipt has to agree with it.
  // It would not if the check ran outside the consent gate, which records the
  // outcome as soon as the handler resolves.
  it('records the refused call as an error rather than a success', async () => {
    const audit = new FakeAuditSink();
    const ports = createInProcessPortPair();
    const runtime = createRuntimeSession(ports.b, new AcknowledgingDefinition(audit));
    const hub = openFakeHub(ports.a);
    await hub.ready;

    await expect(hub.request('runtime.health', {})).rejects.toThrow(
      /Result of "runtime.health" does not match the contract/
    );

    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      method: 'runtime.health',
      outcome: 'error',
      code: 'INTERNAL',
    });

    hub.close(CLOSE_CODES.RELEASED, 'hub stopping');
    await whenRuntimeReleased(runtime);
  });
});

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
