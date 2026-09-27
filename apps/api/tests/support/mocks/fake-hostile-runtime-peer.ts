/**
 * A runtime peer that speaks the raw protocol `Session` directly, with none of
 * a runtime host's own guardrails.
 *
 * `connectTestRuntime` (`../runtime-fixture.ts`) serves its handlers through
 * `RUNTIME_CONTRACT.serve` with `validateResults` on (`../fake-runtime-host.ts`),
 * the same check a real runtime runs before a result reaches the wire. It
 * cannot produce the malformed frame a hub-trust-boundary test needs — the
 * runtime side would refuse it first, and the test would end up proving the
 * wrong thing rejected the wrong way. This
 * peer answers however the test tells it to, so what rejects a bad result or a
 * bad event is provably the hub, not a cooperative peer's own guard.
 *
 * @example
 * const peer = new FakeHostileRuntimePeer();
 * const hub = await openHubSession(peer.hubPort, { hubVersion: 'hub-test' });
 * peer.answer('runtime.health', { unexpected: 'shape' });
 * await hub.request('runtime.health', {}); // rejects: contract violation
 */

import { type EventInput, type Port, Session } from '@mangostudio/protocol';
import { createInProcessPortPair } from '@mangostudio/protocol/in-process';
import {
  RUNTIME_CONTRACT_NAME,
  RUNTIME_CONTRACT_VERSION,
  type RuntimeCapabilityManifest,
} from '@mangostudio/shared/runtime-contract';
import { TEST_RUNTIME_MANIFEST } from '../runtime-fixture';

export class FakeHostileRuntimePeer {
  /** The hub-side end of the pair; hand this to `openHubSession`. */
  readonly hubPort: Port;
  private readonly session: Session;

  constructor(manifest: RuntimeCapabilityManifest = TEST_RUNTIME_MANIFEST) {
    const ports = createInProcessPortPair();
    this.hubPort = ports.a;
    this.session = new Session(ports.b, {
      peer: { name: 'mangostudio-runtime', version: 'hostile-test', role: 'runtime' },
      capabilities: {
        ...manifest,
        contracts: { [RUNTIME_CONTRACT_NAME]: RUNTIME_CONTRACT_VERSION },
      },
      // A test's assertions finish long before a liveness ping would fire; the
      // interval would only hold `bun test` open waiting for one.
      livenessIntervalMs: false,
    });
  }

  /**
   * Answers every call to `method` with `result`, whatever shape it is —
   * registered on the raw session, so nothing checks it against the contract
   * before it is sent.
   */
  answer(method: string, result: unknown): void {
    this.session.handle(method, () => result);
  }

  /** Publishes a raw event frame exactly as `Session.emit` would, unchecked. */
  emit(event: EventInput): boolean {
    return this.session.emit(event);
  }

  close(code?: number, reason?: string): void {
    this.session.close(code, reason);
  }
}
