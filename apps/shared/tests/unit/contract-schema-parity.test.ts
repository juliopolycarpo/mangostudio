import { describe, expect, it } from 'bun:test';
import type { Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import type { AgentId, AgentProfile } from '../../src/agents';
import { AgentProfileSchema } from '../../src/agents';
import type { AppSettings as ModuleAppSettings } from '../../src/app-settings';
import type { ModelOption as ModuleModelOption } from '../../src/catalog';
import type {
  AppSettings as BarrelAppSettings,
  LibraryLocationStatus as BarrelLibraryLocationStatus,
  LibraryResource as BarrelLibraryResource,
  LibraryTargetDescriptor as BarrelLibraryTargetDescriptor,
  ModelOption as BarrelModelOption,
  ProviderObservabilityMetrics as BarrelObsMetrics,
  RuntimeStatus as BarrelRuntimeStatus,
  VersionManagerStatus as BarrelVersionManagerStatus,
} from '../../src/contracts';
import type {
  RuntimeStatus as ModuleRuntimeStatus,
  VersionManagerStatus as ModuleVersionManagerStatus,
} from '../../src/environments';
import type { SSEErrorEvent as ErrorsSSEErrorEvent } from '../../src/errors';
import type {
  LibraryLocationStatus as ModuleLibraryLocationStatus,
  LibraryResource as ModuleLibraryResource,
  LibraryTargetDescriptor as ModuleLibraryTargetDescriptor,
} from '../../src/library';
import {
  type ProviderObservabilityMetrics as ModuleObsMetrics,
  ProviderObservabilityLogsResponseSchema,
  ProviderObservabilityMetricsResponseSchema,
} from '../../src/observability';
import type { ProviderTypeSchema, ReasoningEffortSchema } from '../../src/provider-settings';
import type {
  StreamChunk,
  StreamChunkSchema,
  SSEErrorEvent as StreamingSSEErrorEvent,
} from '../../src/streaming';
import { assertType, type Equals } from '../../src/test-utils/type-assert';
import type { ProviderType, ReasoningEffort } from '../../src/types';

// 1. Domain enums in `types/provider.ts` stay in lockstep with their schemas.
//    These types are hand-written for layering reasons, so a parity assertion is
//    what prevents the union and the TypeBox schema from drifting apart.
assertType<Equals<ProviderType, Static<typeof ProviderTypeSchema>>>();
assertType<Equals<ReasoningEffort, Static<typeof ReasoningEffortSchema>>>();

// 2. The `Type.Unsafe` escape hatch keeps `AgentId` precise. A revert to a plain
//    `Type.String` would collapse this union to `string` and fail here.
assertType<Equals<AgentId, 'chat' | 'default' | 'explore' | `user:${string}`>>();
assertType<Equals<AgentProfile, Static<typeof AgentProfileSchema>>>();

// 3. `SSEErrorEvent` is now defined once (errors) and re-exported by streaming.
assertType<Equals<StreamingSSEErrorEvent, ErrorsSSEErrorEvent>>();

// 3b. `StreamChunk` is derived from `StreamChunkSchema` (schema-first).
assertType<Equals<StreamChunk, Static<typeof StreamChunkSchema>>>();

// 4. The compatibility barrel must stay identical to the canonical modules.
assertType<Equals<BarrelAppSettings, ModuleAppSettings>>();
assertType<Equals<BarrelModelOption, ModuleModelOption>>();
assertType<Equals<BarrelObsMetrics, ModuleObsMetrics>>();
assertType<Equals<BarrelLibraryResource, ModuleLibraryResource>>();
assertType<Equals<BarrelLibraryLocationStatus, ModuleLibraryLocationStatus>>();
assertType<Equals<BarrelLibraryTargetDescriptor, ModuleLibraryTargetDescriptor>>();
assertType<Equals<BarrelRuntimeStatus, ModuleRuntimeStatus>>();
assertType<Equals<BarrelVersionManagerStatus, ModuleVersionManagerStatus>>();

const SAMPLE_PROFILE: AgentProfile = {
  id: 'user:reviewer',
  name: 'Reviewer',
  description: 'Reviews diffs.',
  kind: 'user',
  role: 'subagent',
  source: { type: 'markdown', path: '/agents/reviewer.md' },
  systemPrompt: 'Review carefully.',
  toolNames: ['read', 'grep'],
  toolsEnabled: true,
  subagentIds: [],
  metadata: {},
};

const SAMPLE_METRICS: Static<typeof ProviderObservabilityMetricsResponseSchema> = {
  generatedAt: 1_700_000_000_000,
  providers: [
    {
      provider: 'openai',
      totalProbeTimeouts: 2,
      caches: [{ cacheName: 'sdk-client', hits: 10, misses: 3, hitRate: 0.77 }],
      probeTimeouts: [{ operation: 'healthcheck', timeoutCount: 2 }],
    },
  ],
};

const SAMPLE_LOGS: Static<typeof ProviderObservabilityLogsResponseSchema> = {
  generatedAt: 1_700_000_000_000,
  entries: [
    {
      id: 'log-1',
      timestamp: 1_700_000_000_000,
      provider: 'gemini',
      kind: 'probe-timeout',
      operation: 'model-list',
      message: 'Probe timed out',
    },
  ],
};

describe('contract/schema parity', () => {
  it('keeps the type-level parity assertions compiling under bun run check', () => {
    // The assertType<> calls above are enforced by tsc; this body documents
    // that the suite intentionally relies on compile-time verification.
    expect(true).toBe(true);
  });

  it('validates a schema-typed AgentProfile against its schema', () => {
    expect(Value.Check(AgentProfileSchema, SAMPLE_PROFILE)).toBe(true);
  });
});

describe('observability schemas', () => {
  it('accepts a canonical metrics snapshot', () => {
    expect(Value.Check(ProviderObservabilityMetricsResponseSchema, SAMPLE_METRICS)).toBe(true);
  });

  it('accepts a metrics snapshot with per-provider usage counters', () => {
    expect(
      Value.Check(ProviderObservabilityMetricsResponseSchema, {
        ...SAMPLE_METRICS,
        providers: [
          {
            ...SAMPLE_METRICS.providers[0],
            usage: {
              textTurns: 3,
              imageGenerations: 1,
              inputTokens: 2_048,
              lastUsedAt: 1_700_000_001_000,
            },
          },
        ],
      })
    ).toBe(true);
  });

  it('accepts usage counters without a lastUsedAt timestamp', () => {
    expect(
      Value.Check(ProviderObservabilityMetricsResponseSchema, {
        ...SAMPLE_METRICS,
        providers: [
          {
            ...SAMPLE_METRICS.providers[0],
            usage: { textTurns: 1, imageGenerations: 0, inputTokens: 0 },
          },
        ],
      })
    ).toBe(true);
  });

  it('accepts a canonical logs response', () => {
    expect(Value.Check(ProviderObservabilityLogsResponseSchema, SAMPLE_LOGS)).toBe(true);
  });

  it('rejects unknown provider, cache name, and log kind values', () => {
    expect(
      Value.Check(ProviderObservabilityMetricsResponseSchema, {
        ...SAMPLE_METRICS,
        providers: [{ ...SAMPLE_METRICS.providers[0], provider: 'not-a-provider' }],
      })
    ).toBe(false);

    expect(
      Value.Check(ProviderObservabilityMetricsResponseSchema, {
        ...SAMPLE_METRICS,
        providers: [
          {
            ...SAMPLE_METRICS.providers[0],
            caches: [{ cacheName: 'mystery-cache', hits: 0, misses: 0, hitRate: 0 }],
          },
        ],
      })
    ).toBe(false);

    expect(
      Value.Check(ProviderObservabilityLogsResponseSchema, {
        ...SAMPLE_LOGS,
        entries: [{ ...SAMPLE_LOGS.entries[0], kind: 'unexpected-kind' }],
      })
    ).toBe(false);
  });
});
