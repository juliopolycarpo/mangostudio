import { describe, expect, it } from 'bun:test';
import { defineContract } from '@mangostudio/protocol';
import { MAX_DIRECTORY_HASH_DOMAIN_VERSION } from '@mangostudio/shared/library';
import {
  narrowRuntimeErrorCode,
  RUNTIME_CONTRACT,
  RUNTIME_CONTRACT_NAME,
  RUNTIME_CONTRACT_VERSION,
  RuntimeCapabilityManifestSchema,
} from '@mangostudio/shared/runtime-contract';
import Type from 'typebox';
import Value from 'typebox/value';

const OLD_MANIFEST = {
  platform: 'linux',
  arch: 'x64',
  pathStyle: 'posix' as const,
  homeDir: '/home/peer',
  shells: ['bash'],
  git: { available: true },
  features: {
    tools: true,
    git: true,
    probing: true,
    mcp: true,
    library: true,
    checkpoints: true,
  },
};

describe('RUNTIME_CONTRACT', () => {
  it('publishes a catalog every schema survives', () => {
    const catalog = RUNTIME_CONTRACT.catalog();

    expect(catalog.name).toBe(RUNTIME_CONTRACT_NAME);
    expect(catalog.version).toBe(RUNTIME_CONTRACT_VERSION);
    expect(catalog.methods).toHaveLength(Object.keys(RUNTIME_CONTRACT.definition.methods).length);
    expect(catalog.events).toHaveLength(
      Object.keys(RUNTIME_CONTRACT.definition.events ?? {}).length
    );
    expect(catalog.capabilities).toBeDefined();
  });

  it('names every method and topic in the wire grammar', () => {
    const names = [
      ...Object.keys(RUNTIME_CONTRACT.definition.methods),
      ...Object.keys(RUNTIME_CONTRACT.definition.events ?? {}),
    ];

    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(() =>
        defineContract({
          name: 'grammar.probe',
          version: '1.0.0',
          methods: { [name]: { params: Type.Object({}), result: Type.Null() } },
        })
      ).not.toThrow();
    }
  });

  it('refuses a name the wire grammar does not accept', () => {
    // Without this the case above passes for any name at all.
    expect(() =>
      defineContract({
        name: 'grammar.probe',
        version: '1.0.0',
        methods: { 'fs.Read-File': { params: Type.Object({}), result: Type.Null() } },
      })
    ).toThrow(/not a valid name/);
  });

  it('governs every method by a capability, health alone by none', () => {
    const ungoverned = Object.entries(RUNTIME_CONTRACT.definition.methods)
      .filter(([, entry]) => (entry.capabilities ?? []).length === 0)
      .map(([method]) => method);

    expect(ungoverned).toEqual(['runtime.health']);
  });

  it('validates the external-agent parameters it reuses a schema for', () => {
    expect(() =>
      RUNTIME_CONTRACT.assertParams('external-agent.cancel', { sessionId: 'session-1' })
    ).not.toThrow();
    expect(() => RUNTIME_CONTRACT.assertParams('external-agent.cancel', {})).toThrow(
      /do not match the contract/
    );
  });

  it('accepts any object where a method carries no schema yet', () => {
    expect(() => RUNTIME_CONTRACT.assertParams('fs.read-file', { path: '/tmp/a' })).not.toThrow();
    expect(() => RUNTIME_CONTRACT.assertParams('fs.read-file', 'not an object')).toThrow(
      /do not match the contract/
    );
  });
});

describe('RuntimeCapabilityManifestSchema', () => {
  it('accepts an old manifest that has no external-agent fields', () => {
    expect(Value.Check(RuntimeCapabilityManifestSchema, OLD_MANIFEST)).toBe(true);
  });

  it('accepts an advertised directory-hash domain and treats its absence as valid', () => {
    expect(Value.Check(RuntimeCapabilityManifestSchema, OLD_MANIFEST)).toBe(true);
    expect(
      Value.Check(RuntimeCapabilityManifestSchema, { ...OLD_MANIFEST, directoryHashDomain: 2 })
    ).toBe(true);
    expect(
      Value.Check(RuntimeCapabilityManifestSchema, { ...OLD_MANIFEST, directoryHashDomain: 0 })
    ).toBe(false);
    // The bound the runtime enforces when deriving a version has to be the one
    // the wire accepts, or a hash bump produces a manifest no peer can parse.
    expect(
      Value.Check(RuntimeCapabilityManifestSchema, {
        ...OLD_MANIFEST,
        directoryHashDomain: MAX_DIRECTORY_HASH_DOMAIN_VERSION,
      })
    ).toBe(true);
    expect(
      Value.Check(RuntimeCapabilityManifestSchema, {
        ...OLD_MANIFEST,
        directoryHashDomain: MAX_DIRECTORY_HASH_DOMAIN_VERSION + 1,
      })
    ).toBe(false);
  });

  it('accepts the optional external-agent capability and isolation attestation', () => {
    expect(
      Value.Check(RuntimeCapabilityManifestSchema, {
        ...OLD_MANIFEST,
        features: { ...OLD_MANIFEST.features, externalAgents: true },
        externalAgents: ['codex'],
        identityIsolation: {
          method: 'single-user-host',
          credentialHomeFingerprint: 'sha256:credential-home',
        },
      })
    ).toBe(true);
  });
});

describe('narrowRuntimeErrorCode', () => {
  it('keeps the codes this build knows and folds the rest onto INTERNAL', () => {
    expect(narrowRuntimeErrorCode('DENIED')).toBe('DENIED');
    expect(narrowRuntimeErrorCode('TIMEOUT')).toBe('TIMEOUT');
    expect(narrowRuntimeErrorCode('RUNTIME_UPDATE_REFUSED')).toBe('RUNTIME_UPDATE_REFUSED');
    expect(narrowRuntimeErrorCode('SOMETHING_FROM_THE_FUTURE')).toBe('INTERNAL');
  });
});
