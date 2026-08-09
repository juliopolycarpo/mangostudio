import { describe, expect, it } from 'bun:test';
import { RuntimeConsentDeniedError } from '@mangostudio/runtime';
import type { AgentCliStatus } from '@mangostudio/shared/environments';
import type {
  ExternalAgentCapabilities,
  ExternalAgentTargetId,
} from '@mangostudio/shared/external-agents';
import {
  ExternalAgentDescriptorSchema,
  NO_EXTERNAL_AGENT_CAPABILITIES,
} from '@mangostudio/shared/external-agents';
import type { RuntimeCapabilityManifest } from '@mangostudio/shared/runtime-protocol';
import { Value } from '@sinclair/typebox/value';

import type {
  EnvironmentProbingService,
  ProbeScope,
} from '../../../../src/modules/environments/application/probing-service';
import {
  type AuthoritativeAgentDiscovery,
  type AuthoritativeAgentStatus,
  createExternalAgentDiscoveryService,
  createRuntimeAuthoritativeAgentDiscovery,
  type RuntimeClientResolver,
} from '../../../../src/modules/external-agents/application/external-agent-discovery';

const SCOPE: ProbeScope = { userId: 'user-1', environmentId: 'env-1' };

function agentStatus(overrides: Partial<AgentCliStatus> & { targetId: string }): AgentCliStatus {
  return {
    id: overrides.targetId,
    health: 'ok',
    installations: [],
    findings: [],
    installable: false,
    probedAtMs: 0,
    configHome: `/home/ada/.${overrides.targetId}`,
    configHomeExists: true,
    authenticated: true,
    authSignal: 'file-present',
    locations: [],
    ...overrides,
  } as AgentCliStatus;
}

function installed(targetId: string, version = '1.0.0'): Partial<AgentCliStatus> {
  const installation = {
    path: `/usr/local/bin/${targetId}`,
    rawPath: `/usr/local/bin/${targetId}`,
    version,
    origin: 'path' as const,
    effective: true,
  };
  return { installations: [installation], effective: installation };
}

/** A probing service that answers from a fixture and counts how often it was asked. */
function fakeProbing(statuses: readonly AgentCliStatus[], onCall?: () => void) {
  return {
    listAgentCliStatuses() {
      onCall?.();
      return Promise.resolve([...statuses]);
    },
  } as unknown as EnvironmentProbingService;
}

function failingProbing(message: string) {
  return {
    listAgentCliStatuses(): Promise<AgentCliStatus[]> {
      return Promise.reject(new Error(message));
    },
  } as unknown as EnvironmentProbingService;
}

const ALL_CAPABLE: ExternalAgentCapabilities = {
  ...NO_EXTERNAL_AGENT_CAPABILITIES,
  structuredStreaming: true,
  interactiveApprovals: true,
  cancellation: true,
};

function runtimeManifest(
  overrides: Partial<RuntimeCapabilityManifest> = {}
): RuntimeCapabilityManifest {
  return {
    platform: 'linux',
    arch: 'x64',
    pathStyle: 'posix',
    homeDir: '/home/ada',
    shells: ['bash'],
    git: { available: true },
    features: {
      tools: true,
      git: true,
      probing: true,
      mcp: true,
      library: true,
      checkpoints: true,
      ...overrides.features,
    },
    ...overrides,
  };
}

describe('external agent discovery — the cheap pass', () => {
  it('maps an installed, signed-in CLI', async () => {
    const service = createExternalAgentDiscoveryService({
      probingService: fakeProbing([
        agentStatus({ targetId: 'codex', ...installed('codex', '0.147.0') }),
      ]),
    });

    const [descriptor] = await service.listExternalAgents(SCOPE);

    expect(descriptor).toMatchObject({
      targetId: 'codex',
      environmentId: 'env-1',
      installed: true,
      version: '0.147.0',
      authState: 'signed-in',
    });
    // A signed-in user has nothing to copy into a terminal.
    expect(descriptor?.loginCommand).toBeUndefined();
  });

  it('offers the sign-in command only where running it would help', async () => {
    const service = createExternalAgentDiscoveryService({
      probingService: fakeProbing([
        agentStatus({
          targetId: 'cursor',
          ...installed('cursor'),
          authenticated: false,
          authSignal: 'config-key-absent',
        }),
        agentStatus({
          targetId: 'claude',
          authenticated: false,
          authSignal: 'unknown',
          findings: [{ code: 'cli-not-installed' }],
        }),
      ]),
    });

    const agents = await service.listExternalAgents(SCOPE);
    const cursor = agents.find((agent) => agent.targetId === 'cursor');
    const claude = agents.find((agent) => agent.targetId === 'claude');

    expect(cursor).toMatchObject({ installed: true, authState: 'signed-out' });
    expect(cursor?.loginCommand).toBe('cursor-agent login');
    expect(claude).toMatchObject({ installed: false, authState: 'unknown' });
    expect(claude?.loginCommand).toBeUndefined();
  });

  it("keeps Claude's keychain case unknown rather than guessing signed out", async () => {
    const service = createExternalAgentDiscoveryService({
      probingService: fakeProbing([
        agentStatus({
          targetId: 'claude',
          ...installed('claude'),
          authenticated: false,
          authSignal: 'unknown',
        }),
      ]),
    });

    const [descriptor] = await service.listExternalAgents(SCOPE);

    expect(descriptor?.authState).toBe('unknown');
  });

  it('keeps Claude unknown even when its config home is gone, since the keychain outlives it', async () => {
    const service = createExternalAgentDiscoveryService({
      probingService: fakeProbing([
        agentStatus({
          targetId: 'claude',
          ...installed('claude'),
          configHomeExists: false,
          authenticated: false,
          authSignal: 'unknown',
          findings: [{ code: 'config-home-missing', params: { configHome: '/home/ada/.claude' } }],
        }),
      ]),
    });

    const [descriptor] = await service.listExternalAgents(SCOPE);

    expect(descriptor?.authState).toBe('unknown');
  });

  it('reads a missing config home as a machine nobody has signed in on', async () => {
    const service = createExternalAgentDiscoveryService({
      probingService: fakeProbing([
        agentStatus({
          targetId: 'codex',
          ...installed('codex'),
          configHomeExists: false,
          authenticated: false,
          authSignal: 'unknown',
          findings: [{ code: 'config-home-missing', params: { configHome: '/home/ada/.codex' } }],
        }),
      ]),
    });

    const [descriptor] = await service.listExternalAgents(SCOPE);

    expect(descriptor?.authState).toBe('signed-out');
  });

  it('claims no capability while no adapter has answered', async () => {
    const service = createExternalAgentDiscoveryService({
      probingService: fakeProbing([agentStatus({ targetId: 'codex', ...installed('codex') })]),
    });

    const [descriptor] = await service.listExternalAgents(SCOPE);

    expect(descriptor?.capabilities).toEqual(NO_EXTERNAL_AGENT_CAPABILITIES);
    expect(descriptor?.supportedConfigurations).toEqual([]);
  });

  it('answers for an environment it cannot reach instead of failing the request', async () => {
    const service = createExternalAgentDiscoveryService({
      probingService: failingProbing('Environment "env-1" was not found.'),
    });

    const agents = await service.listExternalAgents(SCOPE);

    expect(agents.map((agent) => agent.targetId)).toEqual(['codex', 'cursor', 'claude']);
    for (const agent of agents) {
      expect(agent.installed).toBe(false);
      expect(agent.authState).toBe('unknown');
    }
  });

  it('returns descriptors that validate against the shared contract', async () => {
    const service = createExternalAgentDiscoveryService({
      probingService: fakeProbing([
        agentStatus({ targetId: 'codex', ...installed('codex') }),
        agentStatus({ targetId: 'cursor', authSignal: 'config-key-absent', authenticated: false }),
        agentStatus({ targetId: 'claude', ...installed('claude'), authSignal: 'unknown' }),
        // The hub's own entry is in the scan and is not an external agent.
        agentStatus({ targetId: 'mangostudio', authSignal: 'session' }),
      ]),
    });

    const agents = await service.listExternalAgents(SCOPE);

    expect(agents).toHaveLength(3);
    for (const agent of agents) {
      expect(Value.Check(ExternalAgentDescriptorSchema, agent)).toBe(true);
    }
  });
});

describe('external agent discovery — the authoritative pass', () => {
  function authoritative(
    statuses: readonly AuthoritativeAgentStatus[],
    hooks: { onCall?: (targets: readonly ExternalAgentTargetId[]) => void; delayMs?: number } = {}
  ): AuthoritativeAgentDiscovery {
    return {
      async describe(_scope: ProbeScope, targetIds: readonly ExternalAgentTargetId[]) {
        hooks.onCall?.(targetIds);
        if (hooks.delayMs) await new Promise((resolve) => setTimeout(resolve, hooks.delayMs));
        return statuses;
      },
    };
  }

  const PROBING = fakeProbing([
    agentStatus({ targetId: 'codex', ...installed('codex', '0.100.0') }),
    agentStatus({ targetId: 'claude', findings: [{ code: 'cli-not-installed' }] }),
  ]);

  it('replaces the scan wherever the adapter has an answer', async () => {
    const service = createExternalAgentDiscoveryService({
      probingService: PROBING,
      authoritative: authoritative([
        {
          targetId: 'codex',
          version: '0.147.0',
          authState: 'signed-out',
          capabilities: ALL_CAPABLE,
          supportedConfigurations: [
            { level: 'read-only', routing: 'user', supported: true, unattended: false },
          ],
          models: [
            {
              id: 'codex-default',
              displayName: 'Codex Default',
              supportedReasoningEfforts: [{ id: 'high', displayName: 'High' }],
            },
          ],
          account: { label: 'Ada', planType: 'Team', fingerprint: 'account-v1' },
        },
      ]),
    });

    const [codex] = await service.listExternalAgents(SCOPE);

    expect(codex).toMatchObject({
      version: '0.147.0',
      authState: 'signed-out',
      capabilities: ALL_CAPABLE,
      loginCommand: 'codex login',
    });
    expect(codex?.supportedConfigurations).toHaveLength(1);
    expect(codex?.models).toEqual([
      {
        id: 'codex-default',
        displayName: 'Codex Default',
        supportedReasoningEfforts: [{ id: 'high', displayName: 'High' }],
      },
    ]);
    expect(codex?.account).toEqual({
      label: 'Ada',
      planType: 'Team',
      fingerprint: 'account-v1',
    });
  });

  it("caps an adapter's version to what the public contract allows", async () => {
    // ExternalAgentDescriptorSchema.version caps at 128 characters. Unlike the
    // cheap pass, an adapter's describe() is this application's own interface,
    // not a wire schema, so nothing upstream bounds a vendor version string
    // before it reaches the response.
    const service = createExternalAgentDiscoveryService({
      probingService: PROBING,
      authoritative: authoritative([
        { targetId: 'codex', version: '9'.repeat(200), capabilities: ALL_CAPABLE },
      ]),
    });

    const [codex] = await service.listExternalAgents(SCOPE);

    expect(codex?.version).toHaveLength(128);
    expect(Value.Check(ExternalAgentDescriptorSchema, codex)).toBe(true);
  });

  it('escalates only the targets the scan found installed', async () => {
    const asked: (readonly ExternalAgentTargetId[])[] = [];
    const service = createExternalAgentDiscoveryService({
      probingService: PROBING,
      authoritative: authoritative([], { onCall: (targets) => asked.push(targets) }),
    });

    await service.listExternalAgents(SCOPE);

    expect(asked).toEqual([['codex']]);
  });

  it('degrades to the scan when the adapter times out, without failing the request', async () => {
    const service = createExternalAgentDiscoveryService({
      probingService: PROBING,
      timeoutMs: 5,
      authoritative: authoritative(
        [{ targetId: 'codex', capabilities: ALL_CAPABLE, version: '0.147.0' }],
        { delayMs: 200 }
      ),
    });

    const [codex] = await service.listExternalAgents(SCOPE);

    expect(codex?.version).toBe('0.100.0');
    expect(codex?.capabilities).toEqual(NO_EXTERNAL_AGENT_CAPABILITIES);
  });

  it('degrades to the scan when the adapter throws', async () => {
    const service = createExternalAgentDiscoveryService({
      probingService: PROBING,
      authoritative: {
        describe: () => Promise.reject(new Error('runtime refused')),
      } satisfies AuthoritativeAgentDiscovery,
    });

    const [codex] = await service.listExternalAgents(SCOPE);

    expect(codex?.capabilities).toEqual(NO_EXTERNAL_AGENT_CAPABILITIES);
    expect(codex?.installed).toBe(true);
  });

  it('collapses a burst of selector renders into one probe', async () => {
    let calls = 0;
    const service = createExternalAgentDiscoveryService({
      probingService: PROBING,
      authoritative: authoritative([{ targetId: 'codex', capabilities: ALL_CAPABLE }], {
        onCall: () => {
          calls += 1;
        },
        delayMs: 10,
      }),
    });

    await Promise.all([
      service.listExternalAgents(SCOPE),
      service.listExternalAgents(SCOPE),
      service.listExternalAgents(SCOPE),
    ]);
    // The fourth arrives after the first settled and is served from the cache.
    await service.listExternalAgents(SCOPE);

    expect(calls).toBe(1);
  });

  it('probes again once the cached answer has expired', async () => {
    let calls = 0;
    let clock = 1_000;
    const service = createExternalAgentDiscoveryService({
      probingService: PROBING,
      cacheTtlMs: 100,
      now: () => clock,
      authoritative: authoritative([{ targetId: 'codex', capabilities: ALL_CAPABLE }], {
        onCall: () => {
          calls += 1;
        },
      }),
    });

    await service.listExternalAgents(SCOPE);
    clock += 101;
    await service.listExternalAgents(SCOPE);

    expect(calls).toBe(2);
  });

  it('drops a cached answer for one environment on request', async () => {
    let calls = 0;
    const service = createExternalAgentDiscoveryService({
      probingService: PROBING,
      authoritative: authoritative([{ targetId: 'codex', capabilities: ALL_CAPABLE }], {
        onCall: () => {
          calls += 1;
        },
      }),
    });

    await service.listExternalAgents(SCOPE);
    service.resetCache('other-env');
    await service.listExternalAgents(SCOPE);
    service.resetCache('env-1');
    await service.listExternalAgents(SCOPE);

    expect(calls).toBe(2);
  });

  it('does not let a stale in-flight probe overwrite a reset cache generation', async () => {
    const stale = Promise.withResolvers<readonly AuthoritativeAgentStatus[]>();
    const fresh = Promise.withResolvers<readonly AuthoritativeAgentStatus[]>();
    const staleStarted = Promise.withResolvers<void>();
    const freshStarted = Promise.withResolvers<void>();
    let calls = 0;
    const service = createExternalAgentDiscoveryService({
      probingService: PROBING,
      authoritative: {
        describe() {
          calls += 1;
          if (calls === 1) {
            staleStarted.resolve();
            return stale.promise;
          }
          freshStarted.resolve();
          return fresh.promise;
        },
      },
    });

    const staleListing = service.listExternalAgents(SCOPE);
    await staleStarted.promise;
    service.resetCache('env-1', 'user-1');

    const freshListing = service.listExternalAgents(SCOPE);
    await freshStarted.promise;
    fresh.resolve([{ targetId: 'codex', version: '2.0.0', capabilities: ALL_CAPABLE }]);
    expect((await freshListing)[0]?.version).toBe('2.0.0');

    stale.resolve([{ targetId: 'codex', version: '1.0.0', capabilities: ALL_CAPABLE }]);
    expect((await staleListing)[0]?.version).toBe('1.0.0');

    expect((await service.listExternalAgents(SCOPE))[0]?.version).toBe('2.0.0');
    expect(calls).toBe(2);
  });

  it("does not let one user's probe consume another user's concurrency slot", async () => {
    // Environments are per-user rows (pk_environments is (userId, id)), so two
    // users can register the same environment id without it being the same
    // machine. The concurrency cap is scoped like the cache and single-flight
    // are — by (user, environment) — so it must not treat these two as one.
    let calls = 0;
    const service = createExternalAgentDiscoveryService({
      probingService: PROBING,
      maxConcurrentPerEnvironment: 1,
      cacheTtlMs: 0,
      authoritative: authoritative([{ targetId: 'codex', capabilities: ALL_CAPABLE }], {
        onCall: () => {
          calls += 1;
        },
        delayMs: 20,
      }),
    });

    const [first, second] = await Promise.all([
      service.listExternalAgents({ userId: 'user-1', environmentId: 'env-1' }),
      service.listExternalAgents({ userId: 'user-2', environmentId: 'env-1' }),
    ]);

    expect(calls).toBe(2);
    expect(first[0]?.capabilities).toEqual(ALL_CAPABLE);
    expect(second[0]?.capabilities).toEqual(ALL_CAPABLE);
  });

  it('holds the concurrency slot until the ignored-abort discovery actually settles', async () => {
    // A timeout answers the caller early, but an adapter that ignores its
    // AbortSignal keeps running underneath. The slot must stay held until that
    // real probe settles, or a caller that keeps asking can start an unbounded
    // number of ignored probes past the stated per-environment cap.
    let started = 0;
    let resolveSlow: (() => void) | undefined;
    const service = createExternalAgentDiscoveryService({
      probingService: PROBING,
      maxConcurrentPerEnvironment: 1,
      cacheTtlMs: 0,
      timeoutMs: 5,
      authoritative: {
        describe() {
          started += 1;
          return new Promise((resolve) => {
            resolveSlow = () => resolve([{ targetId: 'codex', capabilities: ALL_CAPABLE }]);
          });
        },
      } satisfies AuthoritativeAgentDiscovery,
    });

    const [first] = await service.listExternalAgents(SCOPE);
    expect(first?.capabilities).toEqual(NO_EXTERNAL_AGENT_CAPABILITIES);

    const [second] = await service.listExternalAgents(SCOPE);
    expect(started).toBe(1);
    expect(second?.capabilities).toEqual(NO_EXTERNAL_AGENT_CAPABILITIES);

    resolveSlow?.();
  });

  it('renders only capabilities an adapter returned', async () => {
    const service = createExternalAgentDiscoveryService({
      probingService: PROBING,
      authoritative: authoritative([
        { targetId: 'codex', capabilities: { ...NO_EXTERNAL_AGENT_CAPABILITIES, resume: true } },
      ]),
    });

    const [codex] = await service.listExternalAgents(SCOPE);

    expect(codex?.capabilities.resume).toBe(true);
    expect(codex?.capabilities.steering).toBe(false);
  });
});

describe('external agent discovery — runtime authority', () => {
  it('applies unsupported, denied, then unproven isolation in that order', async () => {
    const cases: Array<{
      manifest: RuntimeCapabilityManifest;
      expected: 'runtime-unsupported' | 'runtime-denied' | 'isolation-unproven';
    }> = [
      {
        manifest: runtimeManifest({
          features: { ...runtimeManifest().features, externalAgents: false },
          identityIsolation: {
            method: 'single-user-host',
            credentialHomeFingerprint: 'credential-home-v1',
          },
        }),
        expected: 'runtime-unsupported',
      },
      {
        manifest: runtimeManifest({
          externalAgents: ['codex'],
          features: { ...runtimeManifest().features, externalAgents: false },
          identityIsolation: {
            method: 'single-user-host',
            credentialHomeFingerprint: 'credential-home-v1',
          },
        }),
        expected: 'runtime-denied',
      },
      {
        manifest: runtimeManifest({
          externalAgents: ['codex'],
          features: { ...runtimeManifest().features, externalAgents: true },
        }),
        expected: 'isolation-unproven',
      },
    ];

    for (const { manifest, expected } of cases) {
      let calls = 0;
      const resolveRuntimeClient: RuntimeClientResolver = () =>
        Promise.resolve({
          manifest,
          externalAgents: {
            discover: () => {
              calls += 1;
              return Promise.resolve({ descriptors: [] });
            },
          },
        });
      const authority = createRuntimeAuthoritativeAgentDiscovery(resolveRuntimeClient);

      const [status] = await authority.describe(SCOPE, ['codex'], {
        signal: new AbortController().signal,
      });

      expect(status).toEqual({
        targetId: 'codex',
        capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
        unavailableReason: expected,
      });
      expect(calls).toBe(0);
    }
  });

  it('preserves a consent refusal that races the manifest preflight', async () => {
    const manifest = runtimeManifest({
      externalAgents: ['codex'],
      features: { ...runtimeManifest().features, externalAgents: true },
      identityIsolation: {
        method: 'single-user-host',
        credentialHomeFingerprint: 'credential-home-v1',
      },
    });
    const authority = createRuntimeAuthoritativeAgentDiscovery(() =>
      Promise.resolve({
        manifest,
        externalAgents: {
          discover: () =>
            Promise.reject(
              new RuntimeConsentDeniedError('External agents were revoked.', {
                capability: 'externalAgents',
                method: 'external-agent.discover',
              })
            ),
        },
      })
    );

    expect(
      await authority.describe(SCOPE, ['codex'], { signal: new AbortController().signal })
    ).toEqual([
      {
        targetId: 'codex',
        capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
        unavailableReason: 'runtime-denied',
      },
    ]);
  });

  it('discovers eligible targets and preserves model, account and configuration data', async () => {
    const calls: unknown[] = [];
    const manifest = runtimeManifest({
      externalAgents: ['codex'],
      features: { ...runtimeManifest().features, externalAgents: true },
      identityIsolation: {
        method: 'single-user-host',
        credentialHomeFingerprint: 'credential-home-v1',
      },
    });
    const resolveRuntimeClient: RuntimeClientResolver = (userId, environmentId) => {
      expect([userId, environmentId]).toEqual(['user-1', 'env-1']);
      return Promise.resolve({
        manifest,
        externalAgents: {
          discover(params, options) {
            calls.push({ params, options });
            return Promise.resolve({
              descriptors: [
                {
                  targetId: 'codex',
                  installed: true,
                  version: '0.147.0',
                  authState: 'signed-in',
                  capabilities: ALL_CAPABLE,
                  supportedConfigurations: [
                    {
                      level: 'read-only',
                      routing: 'user',
                      supported: true,
                      unattended: false,
                    },
                  ],
                  models: [{ id: 'codex-default', displayName: 'Codex Default' }],
                  account: { label: 'Ada', planType: 'Team', fingerprint: 'account-v1' },
                },
              ],
            });
          },
        },
      });
    };
    const authority = createRuntimeAuthoritativeAgentDiscovery(resolveRuntimeClient, 4_321);
    const signal = new AbortController().signal;

    const [status] = await authority.describe(SCOPE, ['codex'], { signal });

    expect(calls).toEqual([
      {
        params: { targetIds: ['codex'], timeoutMs: 4_321 },
        options: { signal, timeoutMs: 4_321 },
      },
    ]);
    expect(status).toMatchObject({
      targetId: 'codex',
      capabilities: ALL_CAPABLE,
      supportedConfigurations: [
        { level: 'read-only', routing: 'user', supported: true, unattended: false },
      ],
      models: [{ id: 'codex-default', displayName: 'Codex Default' }],
      account: { label: 'Ada', planType: 'Team', fingerprint: 'account-v1' },
    });
  });
});

describe('the availability gate', () => {
  it('reports every target as not yet available, whatever else is true of it', async () => {
    const service = createExternalAgentDiscoveryService({
      probingService: fakeProbing([
        agentStatus({ targetId: 'codex', ...installed('codex') }),
        agentStatus({ targetId: 'cursor', findings: [{ code: 'cli-not-installed' }] }),
        agentStatus({ targetId: 'claude', ...installed('claude'), authenticated: false }),
      ]),
      authoritative: {
        describe: () =>
          Promise.resolve([{ targetId: 'codex' as const, capabilities: ALL_CAPABLE }]),
      } satisfies AuthoritativeAgentDiscovery,
    });

    const agents = await service.listExternalAgents(SCOPE);

    expect(agents).toHaveLength(3);
    for (const agent of agents) {
      expect(agent.unavailableReason).toBe('not-yet-available');
    }
  });
});
