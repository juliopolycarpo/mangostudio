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
 *
 * **Nothing waits for the authoritative pass.** Its honest budget is 20s per
 * target, because a cold Cursor has no account-level model list and must open a
 * throwaway session just to see a catalog. That is a defensible cost to pay in
 * the background and an indefensible one to pay on the path to rendering a
 * picker. So a request answers from what is already known — a fresh cache entry,
 * an expired one, or the cheap pass on a genuine cold miss — and the probe runs
 * behind the response. When it finds something better than what was served, the
 * owner gets one user-scoped refresh signal on `EXTERNAL_AGENTS_TOPIC` and the
 * client refetches into the now-warm cache.
 *
 * That topic is not the environments one, and the difference is load-bearing:
 * environment invalidation drops this very cache, so publishing it here would
 * make each probe delete its own result and induce the next. See
 * `publishExternalAgentsInvalidation`.
 */

import { RuntimeConsentDeniedError } from '@mangostudio/runtime';
import type { AgentCliStatus } from '@mangostudio/shared/environments';
import type {
  ExternalAgentAccount,
  ExternalAgentAuthState,
  ExternalAgentCapabilities,
  ExternalAgentDescriptor,
  ExternalAgentDiscoveryReport,
  ExternalAgentModel,
  ExternalAgentTargetId,
  ExternalAgentUnavailableReason,
  ExternalSupportedConfiguration,
} from '@mangostudio/shared/external-agents';
import {
  EXTERNAL_AGENT_TARGET_IDS,
  NO_EXTERNAL_AGENT_CAPABILITIES,
} from '@mangostudio/shared/external-agents';
import { onEnvironmentInvalidation } from '../../../services/realtime/environment-invalidation-hooks';
import { publishExternalAgentsInvalidation } from '../../../services/realtime/external-agents-invalidation';
import { getRuntimeClient, type RuntimeClient } from '../../../services/runtime-client';
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
import {
  type ExternalIdentityIsolationRegistry,
  externalIdentityIsolationRegistry,
} from './external-identity-isolation';

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
  readonly models?: readonly ExternalAgentModel[];
  readonly account?: ExternalAgentAccount;
  readonly unavailableReason?: ExternalAgentUnavailableReason;
  /** Whether this answer was probed or remembered, when the adapter caches. */
  readonly discovery?: ExternalAgentDiscoveryReport;
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
  /** Drops cached authoritative answers, optionally narrowed to environment and owner. */
  resetCache(environmentId?: string, userId?: string): void;
}

export interface ExternalAgentDiscoveryOptions {
  readonly probingService?: EnvironmentProbingService;
  /** Omit when no runtime adapter can provide an authoritative answer. */
  readonly authoritative?: AuthoritativeAgentDiscovery;
  readonly now?: () => number;
  readonly cacheTtlMs?: number;
  readonly timeoutMs?: number;
  readonly maxConcurrentPerEnvironment?: number;
  /**
   * How a finished background probe tells the owner its answer improved.
   *
   * Must not be anything that invalidates this service's own cache — see
   * `publishExternalAgentsInvalidation` for why that loops.
   */
  readonly publishRefresh?: (userId: string) => void;
}

/**
 * Long enough that scrolling the selector does not re-probe, short enough that
 * a user who just ran `codex login` in a terminal sees it without a reload.
 */
const DEFAULT_CACHE_TTL_MS = 30_000;

/**
 * The **per-target** budget the runtime enforces around one vendor's probe.
 *
 * A vendor's status command is a subprocess on a possibly remote machine, and
 * it is on the path to rendering a selector, so a slow one is dropped rather
 * than waited on. The number has to fit the slowest supported vendor's *cold*
 * probe, though: Cursor has no account-level model list, so its discovery pays
 * `--version`, `status`, an `acp` handshake and a throwaway `session/new`
 * before a catalog exists — measured at roughly 8s end to end on a warm
 * developer machine. At the old 5s a cold Cursor could never finish, so it
 * never wrote its own 10-minute discovery cache, and the model picker it
 * feeds had nothing to render on any render.
 */
const DEFAULT_TARGET_TIMEOUT_MS = 20_000;

/**
 * Headroom between the runtime's per-target budget and the hub's own patience.
 *
 * The two must not be equal. The runtime discovers every target in parallel
 * under that per-target deadline and then still has to tear down whatever
 * subprocesses it spawned before it can answer, so its reply legitimately
 * lands *after* the slowest target's budget expires. A hub racing on the same
 * number gives up first and throws away the healthy targets that were already
 * in the reply — which is the cheap-pass degradation this module works to
 * avoid, triggered by the hub itself rather than by any vendor.
 */
const DISCOVERY_REPLY_OVERHEAD_MS = 5_000;

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

type RuntimeDiscoveryClient = Pick<RuntimeClient, 'manifest'> & {
  readonly externalAgents: Pick<RuntimeClient['externalAgents'], 'discover'>;
};

export type RuntimeClientResolver = (
  userId: string,
  environmentId: string
) => Promise<RuntimeDiscoveryClient>;

/**
 * Bridges product discovery to the runtime that owns the vendor process.
 *
 * The manifest checks are deliberately ordered. An old runtime has no target
 * entry at all; a new runtime may advertise an adapter while its owner refuses
 * it; and neither is permission to infer an OS-identity guarantee.
 */
export function createRuntimeAuthoritativeAgentDiscovery(
  resolveRuntimeClient: RuntimeClientResolver = getRuntimeClient,
  timeoutMs = DEFAULT_TARGET_TIMEOUT_MS,
  isolationRegistry: ExternalIdentityIsolationRegistry = externalIdentityIsolationRegistry
): AuthoritativeAgentDiscovery {
  return {
    async describe(scope, targetIds, { signal }) {
      const client = await resolveRuntimeClient(scope.userId, scope.environmentId);
      const supportedTargets = new Set(client.manifest.externalAgents ?? []);
      // The runtime's claim, checked against every other user's. A shared SSH
      // account attests exactly like a per-user one, so this is where the two
      // stop being indistinguishable.
      const isolation = isolationRegistry.resolve({
        userId: scope.userId,
        environmentId: scope.environmentId,
        ...(client.manifest.identityIsolation
          ? { isolation: client.manifest.identityIsolation }
          : {}),
      });
      const refused = new Map<ExternalAgentTargetId, AuthoritativeAgentStatus>();
      const discoverable: ExternalAgentTargetId[] = [];

      for (const targetId of targetIds) {
        let unavailableReason: ExternalAgentUnavailableReason | undefined;
        if (!supportedTargets.has(targetId)) unavailableReason = 'runtime-unsupported';
        else if (client.manifest.features.externalAgents !== true) {
          unavailableReason = 'runtime-denied';
        } else if (!isolation) {
          // Two ways to land here, and the distinction is deliberately not
          // exposed: the runtime attested nothing, or it attested a credential
          // home another MangoStudio user also reaches. Telling the second case
          // apart would confirm that somebody else uses this machine.
          unavailableReason = 'isolation-unproven';
        }

        if (unavailableReason) {
          refused.set(targetId, {
            targetId,
            capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
            unavailableReason,
          });
        } else {
          discoverable.push(targetId);
        }
      }

      const byTarget = new Map<ExternalAgentTargetId, AuthoritativeAgentStatus>();
      if (discoverable.length > 0) {
        try {
          const discovered = await client.externalAgents.discover(
            { targetIds: discoverable, timeoutMs },
            { signal, timeoutMs }
          );
          for (const descriptor of discovered.descriptors) {
            byTarget.set(descriptor.targetId, descriptor);
          }
        } catch (error) {
          if (!(error instanceof RuntimeConsentDeniedError)) throw error;
          // Consent can change after the cached manifest check but before the
          // request reaches the runtime gate. Preserve that authoritative
          // refusal instead of degrading it to the optimistic cheap scan.
          for (const targetId of discoverable) {
            refused.set(targetId, {
              targetId,
              capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
              unavailableReason: 'runtime-denied',
            });
          }
        }
      }

      return targetIds.flatMap((targetId) => {
        const status = refused.get(targetId) ?? byTarget.get(targetId);
        return status ? [status] : [];
      });
    },
  };
}

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
  readonly models: readonly ExternalAgentModel[] | undefined;
  readonly account: ExternalAgentAccount | undefined;
  readonly adapterReason: ExternalAgentUnavailableReason | undefined;
  readonly discovery: ExternalAgentDiscoveryReport | undefined;
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
    ...(input.models && { models: input.models }),
    // Personal data, returned only to the user who owns the environment and
    // never persisted past this response.
    ...(input.account && { account: input.account }),
    ...(reason && { unavailableReason: reason }),
    // Diagnostics only. The selector renders none of this; the Logs page does.
    ...(input.discovery && { discovery: input.discovery }),
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
    models: undefined,
    account: undefined,
    adapterReason: undefined,
    discovery: undefined,
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
    models: authoritative.models,
    account: authoritative.account,
    adapterReason: authoritative.unavailableReason,
    discovery: authoritative.discovery,
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
        models: undefined,
        account: undefined,
        adapterReason: 'environment-unreachable',
        discovery: undefined,
      })
    );
  }
}

type AuthoritativeAnswers = ReadonlyMap<ExternalAgentTargetId, AuthoritativeAgentStatus>;

/** No adapter answered: every descriptor stands on the cheap pass alone. */
const NO_ANSWERS: AuthoritativeAnswers = new Map();

/** Product order is fixed, so the selector's row order never depends on probe timing. */
const TARGET_ORDER = new Map(
  EXTERNAL_AGENT_PRODUCT_DESCRIPTORS.map((product, index) => [product.targetId, index])
);

/** The descriptors exactly as the selector will render them. */
function mergeAll(
  base: readonly ExternalAgentDescriptor[],
  answers: AuthoritativeAnswers
): readonly ExternalAgentDescriptor[] {
  return base
    .map((descriptor) => {
      const answer = answers.get(descriptor.targetId);
      return answer ? mergeAuthoritative(descriptor, answer) : descriptor;
    })
    .sort(
      (left, right) =>
        (TARGET_ORDER.get(left.targetId) ?? 0) - (TARGET_ORDER.get(right.targetId) ?? 0)
    );
}

/**
 * Whether a refresh changed anything the user can see.
 *
 * `discovery` is excluded deliberately. It reports `source` — `live` for the
 * probe that ran, `cache` for the next one the adapter answers from memory —
 * and `probedAtMs`, so two runs that found an identical catalog differ there
 * almost every time. None of it reaches the picker; it exists for the Logs page.
 * Comparing it would make every cache expiry look like a change and turn the
 * refresh signal into a guaranteed round trip, which is the cost this check
 * exists to avoid.
 */
function sameRenderedDescriptors(
  left: readonly ExternalAgentDescriptor[],
  right: readonly ExternalAgentDescriptor[]
): boolean {
  if (left.length !== right.length) return false;
  return left.every((descriptor, index) => {
    const other = right[index];
    if (!other) return false;
    const { discovery: _leftDiagnostics, ...leftRendered } = descriptor;
    const { discovery: _rightDiagnostics, ...rightRendered } = other;
    return Bun.deepEquals(leftRendered, rightRendered);
  });
}

interface CacheEntry {
  readonly expiresAt: number;
  readonly generation: number;
  readonly byTarget: AuthoritativeAnswers;
}

interface InflightEntry {
  readonly promise: Promise<AuthoritativeAnswers>;
  readonly generation: number;
  readonly environmentId: string;
  readonly userId: string;
}

export function createExternalAgentDiscoveryService(
  options: ExternalAgentDiscoveryOptions = {}
): ExternalAgentDiscoveryService {
  const probing = options.probingService ?? environmentProbingService;
  const authoritative = options.authoritative;
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TARGET_TIMEOUT_MS + DISCOVERY_REPLY_OVERHEAD_MS;
  const maxConcurrent =
    options.maxConcurrentPerEnvironment ?? DEFAULT_MAX_CONCURRENT_PER_ENVIRONMENT;
  const publishRefresh = options.publishRefresh ?? publishExternalAgentsInvalidation;

  const cache = new Map<
    string,
    CacheEntry & { readonly environmentId: string; readonly userId: string }
  >();
  const inflight = new Map<string, InflightEntry>();
  const generations = new Map<string, number>();
  const running = new Map<string, number>();
  /** Probes that already have someone watching to announce their result. */
  const watched = new Set<string>();

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

  /**
   * What this scope already knows, expired or not, provided a reset has not
   * retired it. An expired entry is still a real adapter answer and beats the
   * capability-free scan, so freshness is reported rather than enforced.
   */
  function rememberedAnswers(
    key: string
  ): { readonly byTarget: AuthoritativeAnswers; readonly fresh: boolean } | undefined {
    const cached = cache.get(key);
    if (!cached || cached.generation !== (generations.get(key) ?? 0)) return undefined;
    return { byTarget: cached.byTarget, fresh: cached.expiresAt > now() };
  }

  function authoritativeFor(
    scope: ProbeScope,
    targetIds: readonly ExternalAgentTargetId[]
  ): Promise<AuthoritativeAnswers> {
    const key = scopeKey(scope);
    const generation = generations.get(key) ?? 0;
    const cached = cache.get(key);
    if (cached && cached.generation === generation && cached.expiresAt > now()) {
      return Promise.resolve(cached.byTarget);
    }

    const existing = inflight.get(key);
    if (existing?.generation === generation) return existing.promise;

    if (!tryEnter(key)) return Promise.resolve(new Map());

    const pending = probeAuthoritative(scope, targetIds, key)
      .then((byTarget) => {
        // A reset can happen while the subprocess is still answering. Its old
        // result may satisfy the caller that started it, but must never
        // repopulate the cache for the newer environment generation.
        if ((generations.get(key) ?? 0) === generation) {
          cache.set(key, {
            expiresAt: now() + cacheTtlMs,
            generation,
            byTarget,
            environmentId: scope.environmentId,
            userId: scope.userId,
          });
        }
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
        if (inflight.get(key)?.generation === generation) inflight.delete(key);
      });

    inflight.set(key, {
      promise: pending,
      generation,
      environmentId: scope.environmentId,
      userId: scope.userId,
    });
    return pending;
  }

  /**
   * Runs the authoritative pass behind an answer that has already been sent,
   * and tells the owner only if it learned something better.
   *
   * Nothing awaits this, which is the entire point: the probe is a vendor
   * subprocess on someone else's machine that can legitimately take ten seconds,
   * and no selector render should sit behind it.
   *
   * One watcher per (scope, generation). The single-flight already collapses
   * concurrent callers onto one subprocess, but each of them would otherwise
   * attach its own completion handler and publish the same conclusion — three
   * renders of one selector becoming three identical signals for one probe.
   * Keying on the generation as well as the scope keeps a reset's replacement
   * probe watchable rather than mistaking it for the one it retired.
   */
  function refreshInBackground(
    scope: ProbeScope,
    base: readonly ExternalAgentDescriptor[],
    targetIds: readonly ExternalAgentTargetId[],
    served: readonly ExternalAgentDescriptor[]
  ): void {
    const key = scopeKey(scope);
    const generation = generations.get(key) ?? 0;
    const watchKey = `${key}${SEPARATOR}${generation}`;
    if (watched.has(watchKey)) return;
    watched.add(watchKey);

    void authoritativeFor(scope, targetIds)
      .then((byTarget) => {
        // A reset landing while the subprocess was still answering retires this
        // result — `authoritativeFor` already refused to cache it. Announcing it
        // anyway would send the client back for an answer this probe is no
        // longer allowed to give, and the refetch would miss and probe again.
        if ((generations.get(key) ?? 0) !== generation) return;
        // Every degraded path lands here as an empty map: a probe that threw or
        // timed out, and one that never started because the environment was at
        // its concurrency cap. None of them is a better answer than what was
        // served, and none is cached — so announcing one would ask the client
        // to refetch straight back into the miss that started another probe.
        if (byTarget.size === 0) return;
        // A refresh that reproduced the served answer must stay silent, or the
        // cache expiring becomes a refetch for every open selector.
        if (sameRenderedDescriptors(served, mergeAll(base, byTarget))) return;
        publishRefresh(scope.userId);
      })
      .catch((error: unknown) => {
        // `authoritativeFor` already absorbs probe failures into an empty map,
        // so this covers the comparison and the publish themselves. Detached
        // work has no caller to reject to; without this the process would take
        // an unhandled rejection.
        console.warn(
          `[external-agents] Background discovery refresh failed for environment ${scope.environmentId}:`,
          error instanceof Error ? error.message : 'unknown error'
        );
      })
      .finally(() => watched.delete(watchKey));
  }

  return {
    async listExternalAgents(scope) {
      const base = await baseDescriptors(probing, scope);

      const escalate = base
        .filter((descriptor) => descriptor.installed)
        .map((descriptor) => descriptor.targetId);
      if (escalate.length === 0 || !authoritative) return mergeAll(base, NO_ANSWERS);

      const remembered = rememberedAnswers(scopeKey(scope));
      if (remembered?.fresh) return mergeAll(base, remembered.byTarget);

      // Stale while revalidate. A cold miss can only offer the cheap pass, but
      // an expired entry still describes this machine from the adapter that
      // would run the turn, so it is served while the probe replacing it runs
      // behind the response.
      const served = mergeAll(base, remembered?.byTarget ?? NO_ANSWERS);
      refreshInBackground(scope, base, escalate, served);
      return served;
    },

    resetCache(environmentId, userId) {
      const keys = new Set([...cache.keys(), ...inflight.keys()]);
      for (const key of keys) {
        const entry = cache.get(key) ?? inflight.get(key);
        if (!entry) continue;
        const environmentMatches = !environmentId || entry.environmentId === environmentId;
        const userMatches = !userId || entry.userId === userId;
        if (!environmentMatches || !userMatches) continue;
        generations.set(key, (generations.get(key) ?? 0) + 1);
        cache.delete(key);
      }
    },
  };
}

export const externalAgentDiscoveryService = createExternalAgentDiscoveryService({
  authoritative: createRuntimeAuthoritativeAgentDiscovery(),
});

onEnvironmentInvalidation((userId) => externalAgentDiscoveryService.resetCache(undefined, userId));
