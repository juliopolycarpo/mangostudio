import { describe, expect, it } from 'bun:test';
import { EnvironmentConnectionStatusSchema } from '@mangostudio/shared/environments';
import type {
  RuntimeCapabilityManifest,
  RuntimeImplementation,
} from '@mangostudio/shared/runtime-contract';
import Value from 'typebox/value';
import { connectTestRuntime, TEST_RUNTIME_MANIFEST } from '../../../support/runtime-fixture';

const IMPLEMENTATION: RuntimeImplementation = {
  schema: 1,
  fingerprint: 'c'.repeat(64),
  features: {
    git: true,
    probing: true,
    mcp: true,
    library: true,
    checkpoints: true,
    fsRead: true,
    fsWrite: true,
    shell: true,
    update: true,
    externalAgents: true,
    terminal: true,
  },
};

const { terminal: _terminal, ...featuresWithoutTerminal } = IMPLEMENTATION.features;

/** Hello manifests whose `implementation` this hub cannot interpret. */
const UNINTERPRETABLE: ReadonlyArray<readonly [string, unknown]> = [
  ['a missing feature key', { ...IMPLEMENTATION, features: featuresWithoutTerminal }],
  ['a fingerprint in another format', { ...IMPLEMENTATION, fingerprint: 'sha256:abc' }],
  ['a newer schema version', { ...IMPLEMENTATION, schema: 2 }],
];

/** Connects a runtime that announces `implementation` and returns what the hub kept. */
async function handshakeManifest(implementation: unknown): Promise<RuntimeCapabilityManifest> {
  const runtime = await connectTestRuntime({
    handlers: {},
    manifest: { ...TEST_RUNTIME_MANIFEST, implementation } as RuntimeCapabilityManifest,
  });
  try {
    return runtime.client.manifest;
  } finally {
    await runtime.close();
  }
}

describe('hello implementation descriptor', () => {
  it('keeps a well-formed descriptor at this schema version', async () => {
    const manifest = await handshakeManifest(IMPLEMENTATION);

    expect(manifest.implementation).toEqual(IMPLEMENTATION);
  });

  for (const [label, implementation] of UNINTERPRETABLE) {
    it(`connects fail-closed, without the descriptor, when it has ${label}`, async () => {
      const manifest = await handshakeManifest(implementation);

      expect(manifest.implementation).toBeUndefined();
      expect(manifest.features).toEqual(TEST_RUNTIME_MANIFEST.features);
      // What the environment status hands the frontend must still validate.
      expect(Value.Check(EnvironmentConnectionStatusSchema, { state: 'connected', manifest })).toBe(
        true
      );
    });
  }
});
