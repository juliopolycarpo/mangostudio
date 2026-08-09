/**
 * Which external agents exist in one environment, and what each can do.
 *
 * Two tiers, in this order:
 *
 * 1. **The cheap pass** — the environment scanner that already runs for the
 *    Environments UI, already cached and already single-flighted. It decides
 *    whether a target is worth escalating.
 * 2. **The authoritative pass** — the runtime's discovery operation, which runs
 *    the vendor's own status command and answers from the adapter that would
 *    run the turn. It replaces the cheap pass wherever the two disagree.
 *
 * The hub spawns no vendor CLI and keeps no second capability table. What it
 * contributes is product copy, policy, caching and authorization.
 *
 * The authoritative pass costs a subprocess on someone else's machine, so its
 * budget is stated here rather than discovered in production: a per-call
 * timeout, a cache TTL per (user, environment), a single-flight so a burst of
 * selector renders produces one probe, and a cap on how many discoveries one
 * environment runs at once. Every failure mode degrades to the cheap pass —
 * discovery never fails the request, because a selector that cannot render is
 * worse than one rendering a stale capability.
 */

import type { AgentCliStatus } from '@mangostudio/shared/environments';
import type {
  ExternalAgentAccount,
  ExternalAgentAuthState,
  ExternalAgentCapabilities,
  ExternalAgentDescriptor,
  ExternalAgentTargetId,
  ExternalAgentUnavailableReason,
  ExternalSupportedConfiguration,
} from '@mangostudio/shared/external-agents';
import {
  EXTERNAL_AGENT_TARGET_IDS,
  NO_EXTERNAL_AGENT_CAPABILITIES,
} from '@mangostudio/shared/external-agents';
import {
  type EnvironmentProbingService,
  environmentProbingService,
  type ProbeScope,
} from '../../environments/application/probing-service';
import {
  EXTERNAL_AGENT_PRODUCT_DESCRIPTORS,
  productDescriptorFor,
} from '../domain/adapter-descriptors';
import { authStateFrom, isInstalled, versionFrom } from '../domain/cli-status-mapping';
import { EXTERNAL_AGENTS_NOT_YET_AVAILABLE } from '../domain/release-gate';

/**
 * One target, as the adapter that would run it describes itself.
 *
 * Every field is optional except the identity and the capabilities: an adapter
 * answers what its vendor's status call told it and stays quiet about the rest,
 * so a missing field means "the cheap pass keeps its answer", not "false".
 */
export interface AuthoritativeAgentStatus {
  readonly targetId: ExternalAgentTargetId;
  readonly installed?: boolean;
  readonly version?: string;
  readonly authState?: ExternalAgentAuthState;
  readonly capabilities: ExternalAgentCapabilities;
  readonly supportedConfigurations?: readonly ExternalSupportedConfiguration[];
  readonly account?: ExternalAgentAccount;
  readonly unavailableReason?: ExternalAgentUnavailableReason;
}

/**
 * The runtime's discovery operation.
 *
 * Implemented once `external-agent.*` protocol methods reach the adapters on
 * the runtime. Until something is registered here, every descriptor is built
 * from the cheap pass alone — which is the honest answer, since with no adapter
 * in the loop no capability is real.
 */
export interface AuthoritativeAgentDiscovery {
  describe(
    scope: ProbeScope,
    targetIds: readonly ExternalAgentTargetId[],
    options: { readonly signal: AbortSignal }
  ): Promise<readonly AuthoritativeAgentStatus[]>;
}

export interface ExternalAgentDiscoveryService {
  listExternalAgents(scope: ProbeScope): Promise<readonly ExternalAgentDescriptor[]>;
  /** Drops cached authoritative answers; without an environment, for every one of them. */
  resetCache(environmentId?: string): void;
}

export interface ExternalAgentDiscoveryOptions {
  readonly probingService?: EnvironmentProbingService;
  /** Absent until plan 003 registers the runtime's adapters. */
  readonly authoritative?: AuthoritativeAgentDiscovery;
  readonly now?: () => number;
  readonly cacheTtlMs?: number;
  readonly timeoutMs?: number;
  readonly maxConcurrentPerEnvironment?: number;
}

/**
 * Long enough that scrolling the selector does not re-probe, short enough that
 * a user who just ran `codex login` in a terminal sees it without a reload.
 */
const DEFAULT_CACHE_TTL_MS = 30_000;

/**
 * The vendor's status command is a subprocess on a possibly remote machine, and
 * it is on the path to rendering a selector. A slow one is dropped rather than
 * waited on.
 */
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Two at a time per (user, environment) — the same scope the cache and the
 * single-flight below use, because environments are per-user rows and two
 * different users can register the same environment id. Single-flight already
 * collapses one caller's own burst into one probe, so this is headroom rather
 * than the primary guard. Anything beyond it takes the cheap pass instead of
 * queueing, because a queued probe would still be waiting when the request
 * that wanted it has gone.
 */
const DEFAULT_MAX_CONCURRENT_PER_ENVIRONMENT = 2;

// Unit separator, not a plain space: userId/environmentId are unlikely to
// contain either, but the escaped form keeps this file text, not binary, in
// git's eyes -- a literal control byte here previously made `git show` report
// "Binary files differ" for this module.
const SEPARATOR = '\u001f';

function scopeKey(scope: ProbeScope): string {
  return `${scope.userId}${SEPARATOR}${scope.environmentId}`;
}

function isExternalTarget(targetId: string): targetId is ExternalAgentTargetId {
  return EXTERNAL_AGENT_TARGET_IDS.some((external) => external === targetId);
}

/**
 * Why a target cannot be selected, most specific first.
 *
 * An adapter's own verdict outranks anything inferred here: only it knows that
 * the runtime has no adapter for this target, that the machine's owner refused
 * consent, or that the transport never attested an isolated identity.
 */
function unavailableReasonFor(
  installed: boolean,
  authState: ExternalAgentAuthState,
  fromAdapter: ExternalAgentUnavailableReason | undefined
): ExternalAgentUnavailableReason | undefined {
  if (fromAdapter) return fromAdapter;
  if (!installed) return 'not-installed';
  if (authState === 'signed-out') return 'signed-out';
  return undefined;
}

interface DescriptorInput {
  readonly targetId: ExternalAgentTargetId;
  readonly environmentId: string;
  readonly installed: boolean;
  readonly authState: ExternalAgentAuthState;
  readonly version: string | undefined;
  readonly capabilities: ExternalAgentCapabilities;
  readonly supportedConfigurations: readonly ExternalSupportedConfiguration[];
  readonly account: ExternalAgentAccount | undefined;
  readonly adapterReason: ExternalAgentUnavailableReason | undefined;
}

/**
 * Matches `ExternalAgentDescriptorSchema.version`'s `maxLength`. The cheap
 * pass is already bounded upstream by the same cap on the wire, but an
 * adapter's `describe()` is this application's own interface, not a schema —
 * nothing stops a future implementation from forwarding a vendor's version
 * string unbounded, and a version past 128 characters would fail response
 * validation and take the whole request down with it.
 */
const MAX_VERSION_LENGTH = 128;

/** One place where a descriptor is assembled, whichever tier supplied the facts. */
function buildDescriptor(input: DescriptorInput): ExternalAgentDescriptor {
  const loginCommand = productDescriptorFor(input.targetId)?.loginCommand;
  const reason = unavailableReasonFor(input.installed, input.authState, input.adapterReason);
  const version = input.version?.slice(0, MAX_VERSION_LENGTH);

  return {
    targetId: input.targetId,
    environmentId: input.environmentId,
    installed: input.installed,
    ...(version && { version }),
    authState: input.authState,
    // Only worth showing to someone who has the CLI but is not signed in.
    ...(input.installed && input.authState !== 'signed-in' && loginCommand && { loginCommand }),
    capabilities: input.capabilities,
    supportedConfigurations: input.supportedConfigurations,
    // Personal data, returned only to the user who owns the environment and
    // never persisted past this response.
    ...(input.account && { account: input.account }),
    ...(reason && { unavailableReason: reason }),
  };
}

function descriptorFrom(
  status: AgentCliStatus,
  environmentId: string
): ExternalAgentDescriptor | null {
  if (!isExternalTarget(status.targetId)) return null;
  if (!productDescriptorFor(status.targetId)) return null;

  return buildDescriptor({
    targetId: status.targetId,
    environmentId,
    installed: isInstalled(status),
    authState: authStateFrom(status),
    version: versionFrom(status),
    // No adapter answered, so no capability is real.
    capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
    supportedConfigurations: [],
    account: undefined,
    adapterReason: undefined,
  });
}

/** The adapter's answer replaces the scan's wherever it has one. */
function mergeAuthoritative(
  base: ExternalAgentDescriptor,
  authoritative: AuthoritativeAgentStatus
): ExternalAgentDescriptor {
  return buildDescriptor({
    targetId: base.targetId,
    environmentId: base.environmentId,
    installed: authoritative.installed ?? base.installed,
    // `unknown` survives only where the status command said nothing usable.
    authState: authoritative.authState ?? base.authState,
    version: authoritative.version ?? base.version,
    capabilities: authoritative.capabilities,
    supportedConfigurations: authoritative.supportedConfigurations ?? [],
    account: authoritative.account,
    adapterReason: authoritative.unavailableReason,
  });
}

/**
 * Everything the cheap pass can say, or — when the environment cannot be
 * reached at all — one unreachable descriptor per target.
 *
 * Answering rather than throwing keeps the selector renderable: a user whose
 * laptop is asleep sees three greyed rows with a reason, not an error page. The
 * same answer covers an environment that is offline, one that was deleted and
 * one that belongs to somebody else, so it discloses nothing either.
 */
async function baseDescriptors(
  probing: EnvironmentProbingService,
  scope: ProbeScope
): Promise<readonly ExternalAgentDescriptor[]> {
  try {
    const statuses = await probing.listAgentCliStatuses(scope);
    return statuses
      .map((status) => descriptorFrom(status, scope.environmentId))
      .filter((descriptor): descriptor is ExternalAgentDescriptor => descriptor !== null);
  } catch (error) {
    console.warn(
      `[external-agents] Could not scan environment ${scope.environmentId}:`,
      error instanceof Error ? error.message : 'unknown error'
    );
    return EXTERNAL_AGENT_TARGET_IDS.map((targetId) =>
      buildDescriptor({
        targetId,
        environmentId: scope.environmentId,
        installed: false,
        authState: 'unknown',
        version: undefined,
        capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
        supportedConfigurations: [],
        account: undefined,
        adapterReason: 'environment-unreachable',
      })
    );
  }
}

/**
 * The one place the availability gate is applied, and the whole of what has to
 * be deleted to lift it.
 */
function applyReleaseGate(descriptor: ExternalAgentDescriptor): ExternalAgentDescriptor {
  return EXTERNAL_AGENTS_NOT_YET_AVAILABLE
    ? { ...descriptor, unavailableReason: 'not-yet-available' }
    : descriptor;
}

interface CacheEntry {
  readonly expiresAt: number;
  readonly byTarget: ReadonlyMap<ExternalAgentTargetId, AuthoritativeAgentStatus>;
}

export function createExternalAgentDiscoveryService(
  options: ExternalAgentDiscoveryOptions = {}
): ExternalAgentDiscoveryService {
  const probing = options.probingService ?? environmentProbingService;
  const authoritative = options.authoritative;
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxConcurrent =
    options.maxConcurrentPerEnvironment ?? DEFAULT_MAX_CONCURRENT_PER_ENVIRONMENT;

  const cache = new Map<string, CacheEntry & { readonly environmentId: string }>();
  const inflight = new Map<
    string,
    Promise<ReadonlyMap<ExternalAgentTargetId, AuthoritativeAgentStatus>>
  >();
  const running = new Map<string, number>();

  function tryEnter(key: string): boolean {
    const current = running.get(key) ?? 0;
    if (current >= maxConcurrent) return false;
    running.set(key, current + 1);
    return true;
  }

  function leave(key: string): void {
    const current = running.get(key) ?? 1;
    if (current <= 1) running.delete(key);
    else running.set(key, current - 1);
  }

  async function probeAuthoritative(
    scope: ProbeScope,
    targetIds: readonly ExternalAgentTargetId[],
    key: string
  ): Promise<ReadonlyMap<ExternalAgentTargetId, AuthoritativeAgentStatus>> {
    if (!authoritative) {
      leave(key);
      return new Map();
    }

    const controller = new AbortController();
    const describing = authoritative.describe(scope, targetIds, { signal: controller.signal });
    // The slot is held for as long as the vendor subprocess actually runs, not
    // for as long as the race below waits for it: an implementation that
    // ignores its abort signal must still be counted against the cap, or the
    // timeout would let a caller start unbounded ignored probes past it. This
    // side chain only exists to release the slot, so its own rejection (the
    // same one `Promise.race` below already handles) is deliberately unhandled.
    describing
      .finally(() => leave(key))
      .catch(() => {
        // Intentionally empty: `describing`'s rejection is already surfaced and
        // handled through the `Promise.race` path below.
      });

    let expire: ((reason: Error) => void) | undefined;
    // The signal asks the discovery to stop; the race stops *waiting* for it.
    // Both are needed — an implementation that ignores its signal would
    // otherwise hold a selector render open for as long as it liked.
    const expired = new Promise<never>((_resolve, reject) => {
      expire = reject;
    });
    const deadline = setTimeout(() => {
      controller.abort();
      expire?.(new Error(`Discovery exceeded ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      const statuses = await Promise.race([describing, expired]);
      return new Map(statuses.map((status) => [status.targetId, status]));
    } finally {
      clearTimeout(deadline);
    }
  }

  function authoritativeFor(
    scope: ProbeScope,
    targetIds: readonly ExternalAgentTargetId[]
  ): Promise<ReadonlyMap<ExternalAgentTargetId, AuthoritativeAgentStatus>> {
    const key = scopeKey(scope);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return Promise.resolve(cached.byTarget);

    const existing = inflight.get(key);
    if (existing) return existing;

    if (!tryEnter(key)) return Promise.resolve(new Map());

    const pending = probeAuthoritative(scope, targetIds, key)
      .then((byTarget) => {
        cache.set(key, {
          expiresAt: now() + cacheTtlMs,
          byTarget,
          environmentId: scope.environmentId,
        });
        return byTarget;
      })
      .catch((error: unknown) => {
        // A refused, timed-out or unreachable runtime is answered with what the
        // scanner already knows. Not caching the failure means the next request
        // tries again rather than inheriting a bad minute.
        console.warn(
          `[external-agents] Authoritative discovery failed for environment ${scope.environmentId}:`,
          error instanceof Error ? error.message : 'unknown error'
        );
        return new Map<ExternalAgentTargetId, AuthoritativeAgentStatus>();
      })
      .finally(() => {
        // The concurrency slot is released inside `probeAuthoritative`, tied to
        // the underlying `describe()` promise rather than to this wrapper —
        // releasing it here too would double-decrement `running`.
        inflight.delete(key);
      });

    inflight.set(key, pending);
    return pending;
  }

  return {
    async listExternalAgents(scope) {
      const base = await baseDescriptors(probing, scope);

      const escalate = base
        .filter((descriptor) => descriptor.installed)
        .map((descriptor) => descriptor.targetId);
      const answers =
        escalate.length > 0 && authoritative
          ? await authoritativeFor(scope, escalate)
          : new Map<ExternalAgentTargetId, AuthoritativeAgentStatus>();

      const order = new Map(
        EXTERNAL_AGENT_PRODUCT_DESCRIPTORS.map((product, index) => [product.targetId, index])
      );

      return base
        .map((descriptor) => {
          const answer = answers.get(descriptor.targetId);
          const merged = answer ? mergeAuthoritative(descriptor, answer) : descriptor;
          return applyReleaseGate(merged);
        })
        .sort((left, right) => (order.get(left.targetId) ?? 0) - (order.get(right.targetId) ?? 0));
    },

    resetCache(environmentId) {
      if (!environmentId) {
        cache.clear();
        return;
      }
      for (const [key, entry] of [...cache.entries()]) {
        if (entry.environmentId === environmentId) cache.delete(key);
      }
    },
  };
}

export const externalAgentDiscoveryService = createExternalAgentDiscoveryService();
