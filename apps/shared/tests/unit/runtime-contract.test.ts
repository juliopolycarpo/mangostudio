import { describe, expect, it } from 'bun:test';
import { defineContract } from '@mangostudio/protocol';
import { MAX_DIRECTORY_HASH_DOMAIN_VERSION } from '@mangostudio/shared/library';
import {
  effectiveTools,
  narrowRuntimeErrorCode,
  RUNTIME_CONTRACT,
  RUNTIME_CONTRACT_NAME,
  RUNTIME_CONTRACT_VERSION,
  RUNTIME_TOOL_GROUPS,
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

  it('requires capabilities except for health, discovery and terminal cleanup', () => {
    const ungoverned = Object.entries(RUNTIME_CONTRACT.definition.methods)
      .filter(([, entry]) => (entry.capabilities ?? []).length === 0)
      .map(([method]) => method);

    expect(ungoverned).toEqual(['terminal.close', 'runtime.health', 'runtime.discover']);
  });

  it('validates the external-agent parameters it reuses a schema for', () => {
    expect(() =>
      RUNTIME_CONTRACT.assertParams('external-agent.cancel', { sessionId: 'session-1' })
    ).not.toThrow();
    expect(() => RUNTIME_CONTRACT.assertParams('external-agent.cancel', {})).toThrow(
      /do not match the contract/
    );
  });

  it('describes no method as a bare object', () => {
    // The whole point of the schemas: a catalog of `{ "type": "object" }` is a
    // catalog that tells a peer generated from it nothing at all.
    const bare = RUNTIME_CONTRACT.catalog()
      .methods.flatMap((method) => [
        [`${method.name} params`, method.params] as const,
        [`${method.name} result`, method.result] as const,
      ])
      .filter(([, schema]) => Object.keys(schema).length === 1 && schema.type === 'object')
      .map(([label]) => label);

    expect(bare).toEqual([]);
  });

  it('refuses a payload missing a member its method requires', () => {
    expect(() =>
      RUNTIME_CONTRACT.assertParams('fs.read-file', {
        chatId: 'chat-1',
        inputPath: 'README.md',
        resolvedPath: '/repo/README.md',
      })
    ).not.toThrow();
    expect(() => RUNTIME_CONTRACT.assertParams('fs.read-file', { chatId: 'chat-1' })).toThrow(
      /do not match the contract/
    );
    expect(() => RUNTIME_CONTRACT.assertParams('fs.read-file', 'not an object')).toThrow(
      /do not match the contract/
    );
  });

  it('ignores a member a newer peer added rather than refusing the call', () => {
    // No wire schema closes its object. A hub one release ahead sends a field
    // this build has never heard of, and refusing the whole call over it would
    // strand exactly the machine that has not been upgraded yet.
    expect(() =>
      RUNTIME_CONTRACT.assertParams('fs.read-file', {
        chatId: 'chat-1',
        inputPath: 'README.md',
        resolvedPath: '/repo/README.md',
        somethingFromTheFuture: 'ignored',
      })
    ).not.toThrow();
  });

  it('requires patch move display and resolved paths as a pair', () => {
    const update = {
      type: 'update',
      inputPath: 'old.txt',
      resolvedPath: '/repo/old.txt',
      hunks: [],
    };
    const params = (operation: Record<string, unknown>) => ({
      chatId: 'chat-1',
      captureSnapshot: false,
      operations: [{ ...update, ...operation }],
    });

    expect(() => RUNTIME_CONTRACT.assertParams('fs.apply-patch', params({}))).not.toThrow();
    expect(() =>
      RUNTIME_CONTRACT.assertParams(
        'fs.apply-patch',
        params({ moveTo: 'new.txt', resolvedMoveTo: '/repo/new.txt' })
      )
    ).not.toThrow();
    expect(() =>
      RUNTIME_CONTRACT.assertParams('fs.apply-patch', params({ moveTo: 'new.txt' }))
    ).toThrow(/do not match the contract/);
    expect(() =>
      RUNTIME_CONTRACT.assertParams('fs.apply-patch', params({ resolvedMoveTo: '/repo/new.txt' }))
    ).toThrow(/do not match the contract/);
  });

  it('leaves a hub-computed number unbounded, and bounds the one already asserted', () => {
    // `assertTerminalSize` in the runtime already refuses these, so the schema
    // replaces a hand-written check rather than inventing a new rejection.
    expect(() =>
      RUNTIME_CONTRACT.assertParams('terminal.resize', { sessionId: 's1', cols: 80, rows: 24 })
    ).not.toThrow();
    expect(() =>
      RUNTIME_CONTRACT.assertParams('terminal.resize', { sessionId: 's1', cols: 0, rows: 24 })
    ).toThrow(/do not match the contract/);

    // Nothing asserts a ceiling on a timeout the hub computed, so nothing here
    // may invent one.
    expect(() =>
      RUNTIME_CONTRACT.assertParams('shell.run', {
        kind: 'bash',
        command: 'true',
        timeoutMs: 7_200_000,
        maxOutputBytes: 1_000_000_000,
      })
    ).not.toThrow();
  });
});

describe('RuntimeCapabilityManifestSchema', () => {
  it('accepts an old manifest that has no external-agent fields', () => {
    expect(Value.Check(RuntimeCapabilityManifestSchema, OLD_MANIFEST)).toBe(true);
  });

  it('accepts an optional revocation-safe terminal close attestation', () => {
    expect(Value.Check(RuntimeCapabilityManifestSchema, OLD_MANIFEST)).toBe(true);
    expect(
      Value.Check(RuntimeCapabilityManifestSchema, {
        ...OLD_MANIFEST,
        terminalCloseAfterRevocation: true,
      })
    ).toBe(true);
    expect(
      Value.Check(RuntimeCapabilityManifestSchema, {
        ...OLD_MANIFEST,
        terminalCloseAfterRevocation: 'true',
      })
    ).toBe(false);
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

  it("keeps a newer peer's unknown manifest keys valid rather than refusing it", () => {
    // Rollout is not atomic: a runtime one release ahead announces fields this
    // build has never heard of, and a schema that refused them would strand the
    // machine that was upgraded first — including the live-update path that
    // would have brought the hub level with it.
    expect(
      Value.Check(RuntimeCapabilityManifestSchema, {
        ...OLD_MANIFEST,
        git: { ...OLD_MANIFEST.git, vendor: 'extra' },
        features: { ...OLD_MANIFEST.features, futureFlag: false },
        somethingFromTheFuture: 'ignored',
      })
    ).toBe(true);
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

describe('effectiveTools', () => {
  it('is true when any tool group is effective', () => {
    expect(effectiveTools({ git: false, fsRead: true })).toBe(true);
  });

  it('is false when no tool group is effective, whatever else is granted', () => {
    const noGroups = Object.fromEntries(RUNTIME_TOOL_GROUPS.map((group) => [group, false]));
    expect(effectiveTools(noGroups)).toBe(false);
    expect(effectiveTools({})).toBe(false);
  });

  it('counts exactly the eight tool groups, not update or externalAgents', () => {
    expect([...RUNTIME_TOOL_GROUPS].sort() as string[]).toEqual(
      ['checkpoints', 'fsRead', 'fsWrite', 'git', 'library', 'mcp', 'probing', 'shell'].sort()
    );
  });
});
