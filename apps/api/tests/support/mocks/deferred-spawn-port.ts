/**
 * A spawned runtime whose handshake never arrives until the test releases it.
 *
 * `spawnRuntimeChild`'s injected `spawnPort` dependency is synchronous — the
 * asynchrony worth controlling for a cancellation test is the handshake
 * session on the far end, not the spawn call itself. This hands back one end
 * of an in-process port pair right away and holds off constructing the
 * runtime-side `Session` — the thing that actually sends a hello, the same
 * way `FakeHostileRuntimePeer` does — until `release()` is called, so a test
 * can cancel a connect attempt while the handshake is still unanswered, then
 * prove a late answer changes nothing.
 *
 * @example
 * const fake = new DeferredSpawnPort();
 * const attempt = spawnRuntimeChild(
 *   { ..., signal: controller.signal },
 *   { spawnPort: fake.spawnPort }
 * );
 * controller.abort();
 * const error = await attempt.catch((caught) => caught);
 * fake.release(); // late; already-closed, so this is a no-op
 * expect(fake.terminateCallCount).toBe(1);
 */

import { CLOSE_CODES, type Port, Session } from '@mangostudio/protocol';
import { createInProcessPortPair } from '@mangostudio/protocol/in-process';
import type { ExitStatus, SpawnedPeer } from '@mangostudio/protocol/spawn';
import {
  RUNTIME_CONTRACT_NAME,
  RUNTIME_CONTRACT_VERSION,
  type RuntimeCapabilityManifest,
} from '@mangostudio/shared/runtime-contract';
import { TEST_RUNTIME_MANIFEST } from '../runtime-fixture';

export class DeferredSpawnPort {
  #runtimeSidePort: Port | undefined;
  readonly #exit = Promise.withResolvers<ExitStatus>();
  terminateCallCount = 0;
  spawnCallCount = 0;

  /** Hand this as the injected `spawnPort` dependency. */
  readonly spawnPort = (): SpawnedPeer => {
    this.spawnCallCount += 1;
    const { a, b } = createInProcessPortPair();
    this.#runtimeSidePort = b;
    return {
      port: a,
      pid: 4321,
      exited: this.#exit.promise,
      stderrTail: () => '',
      terminate: () => {
        this.terminateCallCount += 1;
        // Closing `b` — the far end from `a`'s perspective — is what fires
        // `a`'s own `onClosed` listeners (see `Port.onClosed`'s doc: an
        // owner-initiated close never notifies its own side). That is the
        // half a real child dying actually triggers: its pipes close, and
        // the hub-side port notices.
        this.#runtimeSidePort?.close(CLOSE_CODES.RELEASED, 'terminated by the launcher');
        const status: ExitStatus = { code: null, signal: 'SIGTERM' };
        this.#exit.resolve(status);
        return Promise.resolve(status);
      },
    };
  };

  /**
   * Lets the gated handshake proceed: builds the runtime-side `Session`,
   * which sends its hello over the port pair. A no-op once `terminate()` has
   * already closed the pair — a hello that arrives after has nowhere to
   * land, exactly like a real reply racing a pipe the launcher already tore
   * down.
   */
  release(manifest: RuntimeCapabilityManifest = TEST_RUNTIME_MANIFEST, version = 'hub-test'): void {
    const port = this.#runtimeSidePort;
    if (!port) throw new Error('DeferredSpawnPort: release() called before spawnPort() ran.');
    try {
      new Session(port, {
        peer: { name: 'mangostudio-runtime', version, role: 'runtime' },
        capabilities: {
          ...manifest,
          contracts: { [RUNTIME_CONTRACT_NAME]: RUNTIME_CONTRACT_VERSION },
        },
        livenessIntervalMs: false,
      });
    } catch {
      // See the doc comment above.
    }
  }
}
