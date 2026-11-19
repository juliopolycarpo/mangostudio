import { describe, expect, it } from 'bun:test';

import { HUB_TERMINAL_MARKER_CAPABILITY } from '@mangostudio/shared/runtime-contract';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';

import {
  connectFakeRuntime,
  FakeRuntimeDefinition,
  fixedConsent,
} from '../../../support/fake-runtime-host';
import { TEST_RUNTIME_MANIFEST } from '../../../support/runtime-fixture';

/**
 * #2537. A runtime only marks terminal events for a hub that said, in its hello, that its envelope
 * schema declares the key. The runtime reads this announcement, so what the hub puts on the wire is
 * the contract under test, not an internal.
 */
describe('hub announcement of the terminal-event marker', () => {
  it('tells the runtime, in the hub hello, that terminal markers are readable', async () => {
    const definition = new FakeRuntimeDefinition({
      runtimeVersion: 'runtime-test',
      manifest: TEST_RUNTIME_MANIFEST,
      consent: fixedConsent(RUNTIME_CONSENT_PRESETS.full, 'host'),
      handlers: {},
    });
    const connection = await connectFakeRuntime(definition, { hubVersion: 'hub-test' });

    try {
      const announced = connection.runtime.remote.capabilities;
      expect(
        announced[HUB_TERMINAL_MARKER_CAPABILITY],
        `hello.capabilities.${HUB_TERMINAL_MARKER_CAPABILITY}: expected true | received ${JSON.stringify(announced[HUB_TERMINAL_MARKER_CAPABILITY])}`
      ).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it('spells the capability the way the Rust runtime reads it', () => {
    // `crates/mangostudio-runtime-cold/src/external_agents/mod.rs` reads the same literal.
    expect(HUB_TERMINAL_MARKER_CAPABILITY).toBe('externalAgentTerminalMarker');
  });
});
