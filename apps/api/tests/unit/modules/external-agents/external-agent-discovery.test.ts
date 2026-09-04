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
import Value from 'typebox/value';

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

  /**
   * A stand-in for the realtime publish, and the sync point tests wait on.
   *
   * Nothing awaits the background probe by design, so a test that wants the
   * refreshed answer waits for the signal the probe sends when it lands rather
   * than for a timer. Publishes are recorded so "exactly once" and "not at all"
   * are both assertable.
   */
  function refreshSignal() {
    const published: string[] = [];
    let notify: (() => void) | undefined;
    return {
      published,
      publishRefresh(userId: string) {
        published.push(userId);
        notify?.();
      },
      /** Settles once `publishRefresh` has fired at least `count` times. */
      async untilPublished(count: number): Promise<void> {
        while (published.length < count) {
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
        }
      },
    };
  }

  /** Lets a detached probe run to completion when it publishes nothing to wait on. */
  async function drainBackgroundWork(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  it('replaces the scan wherever the adapter has an answer', async () => {
    const signal = refreshSignal();
    const service = createExternalAgentDiscoveryService({
      probingService: PROBING,
      publishRefresh: signal.publishRefresh,
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

    // The first call answers from the cheap pass and probes behind it.
    await service.listExternalAgents(SCOPE);
    await signal.untilPublished(1);
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
    const signal = refreshSignal();
    const service = createExternalAgentDiscoveryService({
      probingService: PROBING,
      publishRefresh: signal.publishRefresh,
      authoritative: authoritative([
        { targetId: 'codex', version: '9'.repeat(200), capabilities: ALL_CAPABLE },
      ]),
    });

    await service.listExternalAgents(SCOPE);
    await signal.untilPublished(1);
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
    const signal = refreshSignal();
    const service = createExternalAgentDiscoveryService({
      probingService: PROBING,
      cacheTtlMs: 100,
      now: () => clock,
      publishRefresh: signal.publishRefresh,
      authoritative: authoritative([{ targetId: 'codex', capabilities: ALL_CAPABLE }], {
        onCall: () => {
          calls += 1;
        },
      }),
    });

    await service.listExternalAgents(SCOPE);
    // Wait for the first probe to land, or the second call joins it in flight
    // instead of starting the new probe this test is about.
    await signal.untilPublished(1);
    clock += 101;
    await service.listExternalAgents(SCOPE);

    expect(calls).toBe(2);
  });

  it('serves the expired answer while the probe that replaces it runs', async () => {
    // An expired entry is still an adapter's answer about this machine, so it
    // beats falling back to the capability-free scan. Only a cold miss does that.
    let clock = 1_000;
    const signal = refreshSignal();
    const service = createExternalAgentDiscoveryService({
      probingService: PROBING,
      cacheTtlMs: 100,
      now: () => clock,
      publishRefresh: signal.publishRefresh,
      authoritative: authoritative([
        { targetId: 'codex', version: '0.147.0', capabilities: ALL_CAPABLE },
      ]),
    });

    await service.listExternalAgents(SCOPE);
    await signal.untilPublished(1);
    clock += 101;

    const [codex] = await service.listExternalAgents(SCOPE);

    expect(codex?.version).toBe('0.147.0');
    expect(codex?.capabilities).toEqual(ALL_CAPABLE);
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
    const signal = refreshSignal();
    const service = createExternalAgentDiscoveryService({
      probingService: PROBING,
      publishRefresh: signal.publishRefresh,
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

    // Both listings answer from the cheap pass; their probes run behind them.
    expect((await service.listExternalAgents(SCOPE))[0]?.version).toBe('0.100.0');
    await staleStarted.promise;
    service.resetCache('env-1', 'user-1');

    expect((await service.listExternalAgents(SCOPE))[0]?.version).toBe('0.100.0');
    await freshStarted.promise;
    fresh.resolve([{ targetId: 'codex', version: '2.0.0', capabilities: ALL_CAPABLE }]);
    await signal.untilPublished(1);
    expect((await service.listExternalAgents(SCOPE))[0]?.version).toBe('2.0.0');

    stale.resolve([{ targetId: 'codex', version: '1.0.0', capabilities: ALL_CAPABLE }]);
    await drainBackgroundWork();

    // The retired probe neither repopulated the cache nor announced its answer:
    // a refresh signal for a result that was discarded would send the client
    // back for something this probe is no longer allowed to give.
    expect((await service.listExternalAgents(SCOPE))[0]?.version).toBe('2.0.0');
    expect(signal.published).toEqual(['user-1']);
    expect(calls).toBe(2);
  });

  it("does not let one user's probe consume another user's concurrency slot", async () => {
    // Environments are per-user rows (pk_environments is (userId, id)), so two
    // users can register the same environment id without it being the same
    // machine. The concurrency cap is scoped like the cache and single-flight
    // are — by (user, environment) — so it must not treat these two as one.
    let calls = 0;
    const signal = refreshSignal();
    const service = createExternalAgentDiscoveryService({
      probingService: PROBING,
      maxConcurrentPerEnvironment: 1,
      cacheTtlMs: 0,
      publishRefresh: signal.publishRefresh,
      authoritative: authoritative([{ targetId: 'codex', capabilities: ALL_CAPABLE }], {
        onCall: () => {
          calls += 1;
        },
        delayMs: 20,
      }),
    });

    await Promise.all([
      service.listExternalAgents({ userId: 'user-1', environmentId: 'env-1' }),
      service.listExternalAgents({ userId: 'user-2', environmentId: 'env-1' }),
    ]);

    expect(calls).toBe(2);
    await signal.untilPublished(2);
    // Each owner is told about their own machine and nobody else's.
    expect([...signal.published].sort()).toEqual(['user-1', 'user-2']);

    const [first] = await service.listExternalAgents({ userId: 'user-1', environmentId: 'env-1' });
    const [second] = await service.listExternalAgents({ userId: 'user-2', environmentId: 'env-1' });
    expect(first?.capabilities).toEqual(ALL_CAPABLE);
    expect(second?.capabilities).toEqual(ALL_CAPABLE);
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
    const signal = refreshSignal();
    const service = createExternalAgentDiscoveryService({
      probingService: PROBING,
      publishRefresh: signal.publishRefresh,
      authoritative: authoritative([
        { targetId: 'codex', capabilities: { ...NO_EXTERNAL_AGENT_CAPABILITIES, resume: true } },
      ]),
    });

    await service.listExternalAgents(SCOPE);
    await signal.untilPublished(1);
    const [codex] = await service.listExternalAgents(SCOPE);

    expect(codex?.capabilities.resume).toBe(true);
    expect(codex?.capabilities.steering).toBe(false);
  });

  /**
   * The #813 shape: nothing is wrong with the install, and it still cannot run.
   *
   * Inferred here rather than reported, because no adapter is in a position to
   * say it — each one states why *its* cells are refused, not that the result
   * leaves the user nothing to select. Without this the target looks selectable
   * right up until a send is refused.
   */
  it('reports an agent that supports no combination as installed but unusable', async () => {
    const signal = refreshSignal();
    const service = createExternalAgentDiscoveryService({
      probingService: fakeProbing([agentStatus({ targetId: 'codex', ...installed('codex') })]),
      publishRefresh: signal.publishRefresh,
      authoritative: authoritative([
        {
          targetId: 'codex',
          authState: 'signed-in',
          capabilities: ALL_CAPABLE,
          supportedConfigurations: [
            { level: 'read-only', routing: 'user', supported: false, unattended: false },
            { level: 'default', routing: 'user', supported: false, unattended: false },
          ],
        },
      ]),
    });

    await service.listExternalAgents(SCOPE);
    await signal.untilPublished(1);
    const [codex] = await service.listExternalAgents(SCOPE);

    expect(codex?.unavailableReason).toBe('installed-but-unusable');
    expect(codex?.remedy?.kind).toBe('contact-admin');
  });

  describe('the background refresh', () => {
    it('answers a cold request without waiting for the authoritative pass', async () => {
      const probeStarted = Promise.withResolvers<void>();
      const openProbe = Promise.withResolvers<readonly AuthoritativeAgentStatus[]>();
      const service = createExternalAgentDiscoveryService({
        probingService: PROBING,
        timeoutMs: 60_000,
        publishRefresh: () => undefined,
        authoritative: {
          describe() {
            probeStarted.resolve();
            return openProbe.promise;
          },
        },
      });

      const agents = await service.listExternalAgents(SCOPE);

      // This resolved while the probe is still open — the whole point of the
      // change. A vendor with no account-level model list can hold that probe
      // for the better part of ten seconds, and no picker should render behind it.
      await probeStarted.promise;
      expect(agents[0]?.version).toBe('0.100.0');
      expect(agents[0]?.capabilities).toEqual(NO_EXTERNAL_AGENT_CAPABILITIES);

      openProbe.resolve([]);
    });

    it('publishes one refresh when the probe improves on what was served', async () => {
      const signal = refreshSignal();
      const service = createExternalAgentDiscoveryService({
        probingService: PROBING,
        publishRefresh: signal.publishRefresh,
        authoritative: authoritative([
          { targetId: 'codex', version: '0.147.0', capabilities: ALL_CAPABLE },
        ]),
      });

      await service.listExternalAgents(SCOPE);
      await signal.untilPublished(1);
      await drainBackgroundWork();

      expect(signal.published).toEqual(['user-1']);
    });

    it('publishes once per probe, not once per caller waiting on it', async () => {
      // The single-flight collapses a burst of selector renders onto one vendor
      // subprocess, but every caller reaching it would otherwise attach its own
      // completion handler and announce the same conclusion. One probe has to
      // mean one signal, or a burst of renders fans out into a burst of
      // refetches for every socket the owner has open.
      let probes = 0;
      const signal = refreshSignal();
      const service = createExternalAgentDiscoveryService({
        probingService: PROBING,
        publishRefresh: signal.publishRefresh,
        authoritative: authoritative(
          [{ targetId: 'codex', version: '0.147.0', capabilities: ALL_CAPABLE }],
          {
            onCall: () => {
              probes += 1;
            },
            delayMs: 10,
          }
        ),
      });

      await Promise.all([
        service.listExternalAgents(SCOPE),
        service.listExternalAgents(SCOPE),
        service.listExternalAgents(SCOPE),
      ]);
      await signal.untilPublished(1);
      await drainBackgroundWork();

      expect(probes).toBe(1);
      expect(signal.published).toEqual(['user-1']);
    });

    it('still probes after a reset retires the probe already being watched', async () => {
      // The one-watcher-per-probe guard is keyed on the cache generation too. A
      // reset makes the running probe's result unusable, so the request that
      // follows it must be able to start and watch a replacement rather than
      // being mistaken for another caller of the probe it just retired.
      let probes = 0;
      const signal = refreshSignal();
      const service = createExternalAgentDiscoveryService({
        probingService: PROBING,
        authoritative: authoritative(
          [{ targetId: 'codex', version: '0.147.0', capabilities: ALL_CAPABLE }],
          {
            onCall: () => {
              probes += 1;
            },
            delayMs: 10,
          }
        ),
        publishRefresh: signal.publishRefresh,
      });

      await service.listExternalAgents(SCOPE);
      service.resetCache('env-1', 'user-1');
      await service.listExternalAgents(SCOPE);
      await signal.untilPublished(1);
      await drainBackgroundWork();

      expect(probes).toBe(2);
      // Only the surviving generation's probe announced itself.
      expect(signal.published).toEqual(['user-1']);
    });

    it('stays silent when a refresh reproduces the answer it already served', async () => {
      let clock = 1_000;
      const signal = refreshSignal();
      const service = createExternalAgentDiscoveryService({
        probingService: PROBING,
        cacheTtlMs: 100,
        now: () => clock,
        publishRefresh: signal.publishRefresh,
        authoritative: authoritative([
          { targetId: 'codex', version: '0.147.0', capabilities: ALL_CAPABLE },
        ]),
      });

      await service.listExternalAgents(SCOPE);
      await signal.untilPublished(1);

      // Expire the entry and let the refresh find exactly the same catalog.
      clock += 101;
      await service.listExternalAgents(SCOPE);
      await drainBackgroundWork();

      // Still one. Otherwise every cache expiry is a refetch for every client
      // with a selector open, which is worse than the latency this replaced.
      expect(signal.published).toEqual(['user-1']);
    });

    it('does not count probe diagnostics as a change', async () => {
      // `discovery` carries `source` — `live` for the probe that ran, `cache`
      // for one the adapter answered from memory — and `probedAtMs`. Both differ
      // between runs that found an identical catalog, and neither reaches the
      // picker, so counting them would make the silence above unreachable.
      let clock = 1_000;
      let probes = 0;
      const signal = refreshSignal();
      const service = createExternalAgentDiscoveryService({
        probingService: PROBING,
        cacheTtlMs: 100,
        now: () => clock,
        publishRefresh: signal.publishRefresh,
        authoritative: {
          describe() {
            probes += 1;
            return Promise.resolve([
              {
                targetId: 'codex' as const,
                version: '0.147.0',
                capabilities: ALL_CAPABLE,
                discovery: {
                  source: probes === 1 ? ('live' as const) : ('cache' as const),
                  probedAtMs: 1_000 * probes,
                  attempts: probes,
                },
              },
            ]);
          },
        },
      });

      await service.listExternalAgents(SCOPE);
      await signal.untilPublished(1);
      clock += 101;
      await service.listExternalAgents(SCOPE);
      await drainBackgroundWork();

      expect(probes).toBe(2);
      expect(signal.published).toEqual(['user-1']);
    });

    it('announces nothing when the probe degrades to the cheap pass', async () => {
      const signal = refreshSignal();
      const service = createExternalAgentDiscoveryService({
        probingService: PROBING,
        publishRefresh: signal.publishRefresh,
        authoritative: {
          describe: () => Promise.reject(new Error('runtime refused')),
        } satisfies AuthoritativeAgentDiscovery,
      });

      await service.listExternalAgents(SCOPE);
      await drainBackgroundWork();

      // A failed probe is not a better answer and was not cached. Announcing it
      // would send the client back into the very miss that probes again.
      expect(signal.published).toEqual([]);
    });

    it('does not let one background probe induce another', async () => {
      // The trap this whole design routes around: publishing on a topic that
      // resets this cache would make the refetch miss, probe, publish and reset
      // again — one vendor subprocess per cycle, per user, without end. Neither
      // the single-flight nor the per-environment cap stops that, because both
      // collapse a burst rather than breaking a sequential cycle. What breaks it
      // is that the refresh signal leaves the entry the probe just wrote intact,
      // so the refetch it asks for is a cache hit.
      let probes = 0;
      const signal = refreshSignal();
      const service = createExternalAgentDiscoveryService({
        probingService: PROBING,
        publishRefresh: signal.publishRefresh,
        authoritative: authoritative(
          [{ targetId: 'codex', version: '0.147.0', capabilities: ALL_CAPABLE }],
          {
            onCall: () => {
              probes += 1;
            },
          }
        ),
      });

      await service.listExternalAgents(SCOPE);
      await signal.untilPublished(1);

      // Exactly what the frontend does when the signal arrives.
      for (let refetch = 0; refetch < 3; refetch += 1) {
        await service.listExternalAgents(SCOPE);
        await drainBackgroundWork();
      }

      expect(probes).toBe(1);
      expect(signal.published).toEqual(['user-1']);
    });
  });

  /**
   * A cheap-pass descriptor and an adapter's refusal are byte-identical — every
   * capability false — so provenance cannot be read back off the descriptor.
   * The consent path needs to tell them apart, which is what this reports.
   */
  describe('provenance', () => {
    it('marks a descriptor the adapter never spoke for', async () => {
      const service = createExternalAgentDiscoveryService({ probingService: PROBING });

      const [codex] = await service.describeExternalAgents(SCOPE);

      expect(codex?.adapterAnswered).toBe(false);
    });

    it('marks a descriptor an adapter answered for', async () => {
      const signal = refreshSignal();
      const service = createExternalAgentDiscoveryService({
        probingService: PROBING,
        publishRefresh: signal.publishRefresh,
        authoritative: authoritative([{ targetId: 'codex', capabilities: ALL_CAPABLE }]),
      });

      await service.describeExternalAgents(SCOPE);
      await signal.untilPublished(1);
      const [codex] = await service.describeExternalAgents(SCOPE);

      expect(codex?.adapterAnswered).toBe(true);
    });

    it('waits for the adapter on a cold miss when the caller asks it to', async () => {
      const service = createExternalAgentDiscoveryService({
        probingService: PROBING,
        authoritative: authoritative([{ targetId: 'codex', capabilities: ALL_CAPABLE }], {
          delayMs: 10,
        }),
      });

      const [codex] = await service.describeExternalAgents(SCOPE, { waitForAdapter: true });

      expect(codex?.adapterAnswered).toBe(true);
      expect(codex?.descriptor.capabilities).toEqual(ALL_CAPABLE);
    });

    /**
     * Waiting buys an answer, not a guarantee of one. A refused, timed-out or
     * capped probe still reports "nobody answered" rather than "no
     * capabilities", so the caller refuses instead of storing a placeholder.
     */
    it('reports no answer rather than an empty one when the probe fails', async () => {
      const service = createExternalAgentDiscoveryService({
        probingService: PROBING,
        authoritative: {
          describe: () => Promise.reject(new Error('runtime unreachable')),
        },
      });

      const [codex] = await service.describeExternalAgents(SCOPE, { waitForAdapter: true });

      expect(codex?.adapterAnswered).toBe(false);
      expect(codex?.descriptor.capabilities).toEqual(NO_EXTERNAL_AGENT_CAPABILITIES);
    });

    it('spends no wait when an expired answer is already remembered', async () => {
      let clock = 1_000;
      const signal = refreshSignal();
      const service = createExternalAgentDiscoveryService({
        probingService: PROBING,
        cacheTtlMs: 100,
        now: () => clock,
        publishRefresh: signal.publishRefresh,
        authoritative: authoritative([
          { targetId: 'codex', version: '0.147.0', capabilities: ALL_CAPABLE },
        ]),
      });

      await service.describeExternalAgents(SCOPE);
      await signal.untilPublished(1);
      clock += 101;

      const [codex] = await service.describeExternalAgents(SCOPE, { waitForAdapter: true });

      expect(codex?.adapterAnswered).toBe(true);
      expect(codex?.descriptor.version).toBe('0.147.0');
      await drainBackgroundWork();
    });
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

describe('after the availability gate', () => {
  it('reports each target on its own merits rather than one blanket refusal', async () => {
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
    const byTarget = new Map(agents.map((agent) => [agent.targetId, agent]));

    expect(agents).toHaveLength(3);
    // An installed, signed-in target is now genuinely selectable.
    expect(byTarget.get('codex')?.unavailableReason).toBeUndefined();
    expect(byTarget.get('cursor')?.unavailableReason).toBe('not-installed');
    expect(byTarget.get('claude')?.unavailableReason).toBe('signed-out');
  });

  /**
   * An empty matrix is a cold cache, not a finding. Reading it as one would
   * grey out a working target on the first render after a restart, which is
   * the opposite of what this reason is for.
   */
  it('does not read a cold cache as a target that supports nothing', async () => {
    const service = createExternalAgentDiscoveryService({
      probingService: fakeProbing([agentStatus({ targetId: 'codex', ...installed('codex') })]),
    });

    const [codex] = await service.listExternalAgents(SCOPE);

    expect(codex?.supportedConfigurations).toEqual([]);
    expect(codex?.unavailableReason).toBeUndefined();
  });

  it('carries the sign-in command on the remedy that needs one', async () => {
    const service = createExternalAgentDiscoveryService({
      probingService: fakeProbing([
        agentStatus({ targetId: 'claude', ...installed('claude'), authenticated: false }),
      ]),
    });

    const [claude] = await service.listExternalAgents(SCOPE);

    expect(claude?.remedy).toEqual({ kind: 'sign-in', command: 'claude auth login' });
  });
});
