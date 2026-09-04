import { readFile } from 'node:fs/promises';
import type {
  AgentCliStatus,
  InstallCancelResponse,
  InstallGuard,
  InstallPlatform,
  InstallPreparation,
  InstallPrepareBody,
  InstallProbeEvent,
  InstallProfileSetup,
  InstallRecipeId,
  InstallRecipePreview,
  InstallRun,
  InstallStartBody,
  InstallStartResponse,
  InstallStreamEvent,
  RecipeInput,
  RuntimeId,
  RuntimeStatus,
  VersionManagerStatus,
} from '@mangostudio/shared/environments';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import { isExternalAgentTargetId } from '@mangostudio/shared/external-agents';
import { getConfig } from '../../../lib/config';
import { getInstallLogPath } from '../../../lib/mango-paths';
import { assertRequestedProfileId, resolveActiveProfileId } from '../../../lib/profile-context';
import { isStandaloneExecutable } from '../../../lib/runtime-paths';
import {
  getRuntimeClient,
  getRuntimeConnectionManager,
} from '../../../services/runtime-client/runtime-connection-manager';
import { generateId } from '../../../utils/id';
import { evaluateInstallGuard, evaluateRemoteInstallGuard } from '../domain/install-guards';
import {
  INSTALL_RECIPES,
  type InstallRecipe,
  type InstallRecipeBuildContext,
  writesForPlatform,
} from '../domain/install-recipes';
import { assertRecipeInput } from '../domain/recipe-input';
import { environmentRepository } from '../infrastructure/environment-repository';
import {
  type CompleteInstallRun,
  createInstallRunRepository,
  type InstallRunRepository,
} from '../infrastructure/install-run-repository';
import { type InstallRunner, installRunner } from '../infrastructure/install-runner';
import {
  type InstallerArtifact,
  type InstallerDownloader,
  installerDownloader,
} from '../infrastructure/installer-download';
import { inspectProfileSetup, type ProfileSetupInspector } from '../infrastructure/profile-setup';
import {
  type EnvironmentProbingService,
  environmentProbingService,
  type ProbeScope,
} from './probing-service';
import { type ToolchainService, toolchainService } from './toolchain-service';

const PREPARATION_TTL_MS = 10 * 60 * 1000;
const MAX_RECENT_STREAMS = 20;
/** Separates environment from recipe in activity maps so ids stay unambiguous. */
const ACTIVITY_SEP = '\u001f';

export interface InstallRequestContext {
  readonly userId: string;
  readonly clientIp: string | undefined;
  /** Which machine to install on; the hub's own unless a caller says otherwise. */
  readonly environmentId?: string;
  readonly signal?: AbortSignal;
}

function environmentIdOf(context: Pick<InstallRequestContext, 'environmentId'>): string {
  return context.environmentId ?? LOCAL_ENVIRONMENT_ID;
}

/** The machine a recipe is about. */
function probeScopeFor(
  context: Pick<InstallRequestContext, 'userId' | 'environmentId'>
): ProbeScope {
  return { userId: context.userId, environmentId: environmentIdOf(context) };
}

/** Concurrent same-recipe installs on different machines must not attach. */
function activityKey(environmentId: string, recipeId: InstallRecipeId): string {
  return `${environmentId}${ACTIVITY_SEP}${recipeId}`;
}

export class InstallBlockedError extends Error {
  constructor(readonly recipe: InstallRecipePreview) {
    super('Environment installs are blocked by the local-surface guard.');
    this.name = 'InstallBlockedError';
  }
}

export class InstallUnavailableError extends Error {
  constructor(
    readonly recipe: InstallRecipePreview,
    message: string
  ) {
    super(message);
    this.name = 'InstallUnavailableError';
  }
}

export class InstallPreparationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallPreparationError';
  }
}

export class InstallConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallConflictError';
  }
}

interface PreparedInstall {
  readonly id: string;
  readonly userId: string;
  readonly recipeId: InstallRecipeId;
  readonly inputKey: string;
  readonly expiresAt: number;
  readonly artifact: InstallerArtifact;
}

interface EventBuffer {
  readonly events: InstallStreamEvent[];
  readonly closed: boolean;
  publish(event: InstallStreamEvent): void;
  close(): void;
  subscribe(): AsyncIterable<InstallStreamEvent>;
}

interface ActiveInstall {
  readonly runId: string;
  readonly userId: string;
  readonly profileId: string;
  readonly recipeId: InstallRecipeId;
  readonly environmentId: string;
  readonly abortController: AbortController;
  readonly stream: EventBuffer;
}

interface RecentInstallStream {
  readonly userId: string;
  readonly stream: EventBuffer;
}

interface StartingInstall {
  readonly userId: string;
  readonly promise: Promise<InstallStartResponse>;
}

interface RecipeRequirements {
  readonly missing: RuntimeId[];
  readonly nvmDir?: string;
  /** Absolute path of every resolved requirement, keyed by runtime id. */
  readonly binaryPaths: Partial<Record<RuntimeId, string>>;
}

interface InstallServiceDeps {
  readonly recipes: readonly InstallRecipe[];
  readonly probingService: EnvironmentProbingService;
  readonly toolchain: ToolchainService;
  readonly repository: InstallRunRepository;
  readonly downloader: InstallerDownloader;
  readonly runner: InstallRunner;
  readonly now: () => number;
  readonly generateId: () => string;
  /** Fallback platform when the target runtime has not handshaked yet. */
  readonly platform: string;
  /** Target machine platform; defaults to the runtime manifest for remotes. */
  readonly resolvePlatform?: (scope: ProbeScope) => Promise<string>;
  readonly getLogPath: (runId: string) => string;
  readonly readLog: (path: string) => Promise<string>;
  readonly inspectProfileSetup: ProfileSetupInspector;
  readonly resolveGuard: (context: InstallRequestContext) => Promise<InstallGuard>;
}

export interface InstallService {
  listRecipes(context: InstallRequestContext): Promise<InstallRecipePreview[]>;
  prepare(body: InstallPrepareBody, context: InstallRequestContext): Promise<InstallPreparation>;
  start(body: InstallStartBody, context: InstallRequestContext): Promise<InstallStartResponse>;
  cancel(runId: string, userId: string): Promise<InstallCancelResponse | null>;
  listRuns(userId: string): Promise<InstallRun[]>;
  getRunStream(runId: string, userId: string): Promise<AsyncIterable<InstallStreamEvent> | null>;
}

function createEventBuffer(): EventBuffer {
  const events: InstallStreamEvent[] = [];
  const waiters = new Set<() => void>();
  let closed = false;

  const wake = () => {
    const pending = [...waiters];
    waiters.clear();
    for (const waiter of pending) waiter();
  };

  return {
    events,
    get closed() {
      return closed;
    },
    publish(event) {
      if (closed) return;
      events.push(event);
      wake();
    },
    close() {
      if (closed) return;
      closed = true;
      wake();
    },
    subscribe() {
      let cursor = 0;
      let ended = false;
      const pending = new Map<() => void, (result: IteratorResult<InstallStreamEvent>) => void>();
      const done = (): IteratorReturnResult<undefined> => ({ done: true, value: undefined });
      const read = (): IteratorResult<InstallStreamEvent> | null => {
        if (ended) return done();
        if (cursor < events.length) {
          const event = events[cursor] as InstallStreamEvent;
          cursor += 1;
          return { done: false, value: event };
        }
        if (!closed) return null;
        ended = true;
        return done();
      };

      const iterator: AsyncIterableIterator<InstallStreamEvent> = {
        [Symbol.asyncIterator]() {
          return iterator;
        },
        next() {
          const result = read();
          if (result) return Promise.resolve(result);

          return new Promise((resolve) => {
            const waiter = () => {
              const pendingResolve = pending.get(waiter);
              if (!pendingResolve) return;
              const next = read();
              if (!next) {
                waiters.add(waiter);
                return;
              }
              pending.delete(waiter);
              pendingResolve(next);
            };
            pending.set(waiter, resolve);
            waiters.add(waiter);
          });
        },
        return() {
          ended = true;
          const result = done();
          for (const [waiter, resolve] of pending) {
            waiters.delete(waiter);
            resolve(result);
          }
          pending.clear();
          return Promise.resolve(result);
        },
      };
      return iterator;
    },
  };
}

/**
 * Two gates, intersected, and a refusal always names which side said no.
 *
 * For the hub's own machine that is the loopback surface it has always been.
 * For anyone else's it is an explicit per-environment opt-in, because nothing
 * the hub can measure here says anything about a machine over there — and
 * quietly inheriting the local verdict would extend a permission granted for
 * "the browser is at this keyboard" to a host nobody consented for.
 */
async function defaultGuard(context: InstallRequestContext): Promise<InstallGuard> {
  const config = getConfig();
  const environmentId = environmentIdOf(context);
  const status = getRuntimeConnectionManager().getStatus(context.userId, environmentId);
  // Absent on older peers, and on a runtime nobody has connected to yet —
  // treat as granted until consent is visible.
  const runtimeShellAllowed = status.manifest?.features.shell !== false;

  if (environmentId === LOCAL_ENVIRONMENT_ID) {
    return evaluateInstallGuard({
      serverHost: config.server.host,
      clientIp: context.clientIp,
      installsEnabled: config.environments.installsEnabled,
      standalone: isStandaloneExecutable(),
      container: config.environments.container,
      runtimeShellAllowed,
    });
  }

  const environment = await environmentRepository.find(context.userId, environmentId);
  return evaluateRemoteInstallGuard({
    installsEnabled: config.environments.installsEnabled,
    // An environment that is not there cannot have been trusted, and saying so
    // is more useful than a not-found: the user asked to install somewhere.
    allowInstalls: environment?.allowInstalls === true,
    runtimeShellAllowed,
  });
}

/**
 * Canonical preparation key. Property order must not change the identity of an
 * input, so the discriminant and its payload are rendered explicitly instead of
 * relying on `JSON.stringify` key order.
 */
function recipeInputKey(input: RecipeInput): string {
  return input.kind === 'none' ? 'none' : `node-version:${input.version}`;
}

function defaultInput(recipe: InstallRecipe): RecipeInput {
  return recipe.inputKind === 'none' ? { kind: 'none' } : { kind: 'node-version', version: 'lts' };
}

/** The request context, with the environment the body asked for folded in. */
function withEnvironment(
  context: InstallRequestContext,
  environmentId: string | undefined
): InstallRequestContext {
  return environmentId === undefined ? context : { ...context, environmentId };
}

function terminalDuration(run: InstallRun): number {
  return Math.max(0, (run.finishedAt ?? run.startedAt) - run.startedAt);
}

function isInstallPlatform(platform: string): platform is InstallPlatform {
  return platform === 'darwin' || platform === 'linux' || platform === 'win32';
}

async function defaultResolvePlatform(scope: ProbeScope, fallback: string): Promise<string> {
  if (scope.environmentId === LOCAL_ENVIRONMENT_ID) return fallback;
  try {
    const client = await getRuntimeClient(scope.userId, scope.environmentId);
    return client.manifest.platform;
  } catch {
    return fallback;
  }
}

export function createInstallService(overrides: Partial<InstallServiceDeps> = {}): InstallService {
  const deps: InstallServiceDeps = {
    recipes: INSTALL_RECIPES,
    probingService: environmentProbingService,
    toolchain: toolchainService,
    repository: createInstallRunRepository(),
    downloader: installerDownloader,
    runner: installRunner,
    now: Date.now,
    generateId,
    platform: process.platform,
    getLogPath: getInstallLogPath,
    readLog: (path) => readFile(path, 'utf8'),
    inspectProfileSetup,
    resolveGuard: defaultGuard,
    ...overrides,
  };
  const resolvePlatform =
    deps.resolvePlatform ?? ((scope) => defaultResolvePlatform(scope, deps.platform));
  const recipesById = new Map(deps.recipes.map((recipe) => [recipe.id, recipe] as const));
  const preparations = new Map<string, PreparedInstall>();
  const activeByRecipe = new Map<string, ActiveInstall>();
  const activeByRun = new Map<string, ActiveInstall>();
  const recentStreams = new Map<string, RecentInstallStream>();
  const startingByRecipe = new Map<string, StartingInstall>();

  const resolveRecipe = (id: InstallRecipeId): InstallRecipe => {
    // Only the configured recipe set is executable. Falling back to the global
    // registry would let a restricted service run a recipe it does not expose.
    const recipe = recipesById.get(id);
    if (!recipe) throw new Error(`Missing install recipe "${id}".`);
    return recipe;
  };

  const resolveRequirement = async (
    scope: ProbeScope,
    requirement: RuntimeId
  ): Promise<{ available: boolean; path?: string; nvmDir?: string }> => {
    if (requirement === 'nvm') {
      const status = await deps.probingService.getVersionManagerStatus(scope, 'nvm');
      return {
        available: status?.installed === true,
        ...(status?.root && { nvmDir: status.root }),
      };
    }
    // A vendor CLI is probed by the library rather than the runtime detector,
    // but what a resolved requirement *is* — installed, and where — does not
    // depend on which service answered.
    const status = isExternalAgentTargetId(requirement)
      ? await deps.probingService.getAgentCliStatus(scope, requirement)
      : await deps.probingService.getRuntimeStatus(scope, requirement);
    const path = status?.effective?.path ?? status?.installations[0]?.path;
    return {
      available: Boolean(status && status.installations.length > 0),
      ...(path && { path }),
    };
  };

  const inspectRequirements = async (
    scope: ProbeScope,
    recipe: InstallRecipe
  ): Promise<RecipeRequirements> => {
    const missing: RuntimeId[] = [];
    let nvmDir: string | undefined;
    const binaryPaths: Partial<Record<RuntimeId, string>> = {};
    for (const requirement of recipe.requires) {
      const result = await resolveRequirement(scope, requirement);
      if (!result.available) missing.push(requirement);
      if (result.nvmDir) nvmDir = result.nvmDir;
      if (result.path) binaryPaths[requirement] = result.path;
    }
    return { missing, binaryPaths, ...(nvmDir && { nvmDir }) };
  };

  /**
   * Builds a preview and returns the requirement inspection (and the platform
   * it was built against) that produced it, so callers that also need the
   * resolved `nvmDir`/`binaryPaths` do not re-run detection.
   */
  const buildPreviewDetail = async (
    scope: ProbeScope,
    recipe: InstallRecipe,
    input: RecipeInput,
    guard: InstallGuard,
    artifact?: InstallerArtifact
  ): Promise<{
    preview: InstallRecipePreview;
    requirements: RecipeRequirements;
    platform: InstallPlatform;
  }> => {
    assertRecipeInput(input, recipe.inputKind);
    const requirements = await inspectRequirements(scope, recipe);
    const resolvedPlatform = await resolvePlatform(scope);
    const supported =
      isInstallPlatform(resolvedPlatform) && recipe.platforms.includes(resolvedPlatform);
    // A preview is built for every recipe on the host's actual platform, even
    // one this recipe does not support — `supported` already reports that
    // separately. A display argv still needs some concrete `InstallPlatform`
    // to build against, so an unrecognized host platform falls back to one.
    const platform: InstallPlatform = isInstallPlatform(resolvedPlatform)
      ? resolvedPlatform
      : 'linux';
    // Profile files live on the target machine. Inspecting the hub's own home
    // for a remote install would report a lie, so remote previews omit it —
    // and `profileLines` are shell `export` lines, so a win32 target has no
    // profile for them to be missing from either.
    const profileSetup: InstallProfileSetup | undefined =
      recipe.profileLines && scope.environmentId === LOCAL_ENVIRONMENT_ID && platform !== 'win32'
        ? await deps.inspectProfileSetup(recipe.profileLines)
        : undefined;
    // Display-only fallback: a requirement this preview could not resolve
    // still gets its own bare binary name so the argv never throws mid-list —
    // `missingRequirements` is what tells the caller it will not run.
    const displayBinaryPaths: Partial<Record<RuntimeId, string>> = { ...requirements.binaryPaths };
    for (const requirement of recipe.requires) {
      if (!displayBinaryPaths[requirement]) displayBinaryPaths[requirement] = requirement;
    }
    const context: InstallRecipeBuildContext = {
      ...(recipe.download && {
        installerPath: artifact?.path ?? '<downloaded-installer>',
      }),
      ...(requirements.nvmDir && { nvmDir: requirements.nvmDir }),
      ...(!requirements.nvmDir && recipe.requires.includes('nvm') && { nvmDir: '$NVM_DIR' }),
      platform,
      binaryPaths: displayBinaryPaths,
    };
    const argv = recipe.argv ? recipe.argv(input, context) : [];
    const download = recipe.download?.[platform];

    return {
      platform,
      requirements,
      preview: {
        id: recipe.id,
        runtimeId: recipe.runtimeId,
        action: recipe.action,
        inputKind: recipe.inputKind,
        platforms: [...recipe.platforms],
        argv: [...argv],
        copyCommand: recipe.copyCommand(input, platform),
        requires: [...recipe.requires],
        // Narrowed to this machine's spelling: the uninstall confirmation
        // reads these back as "this will remove …", and a Windows path in a
        // Linux dialog names a file that does not exist.
        writes: [...writesForPlatform(recipe.writes, platform)],
        networkAccess: recipe.networkAccess,
        timeoutMs: recipe.timeoutMs,
        supported,
        missingRequirements: requirements.missing,
        guard,
        // False is a property of the recipe, not of the machine: no argv
        // builder means no vendor-documented unattended shape exists.
        runnable: recipe.argv !== undefined,
        ...(recipe.unrunnableReason && { unrunnableReason: recipe.unrunnableReason }),
        ...(download && {
          download: {
            url: artifact?.url ?? download.url,
            ...(download.sha256 && { pinnedSha256: download.sha256 }),
            ...(artifact && {
              sizeBytes: artifact.sizeBytes,
              sha256: artifact.sha256,
            }),
          },
        }),
        ...(profileSetup && { profileSetup }),
      },
    };
  };

  const buildPreview = async (
    recipe: InstallRecipe,
    input: RecipeInput,
    context: InstallRequestContext,
    artifact?: InstallerArtifact
  ): Promise<InstallRecipePreview> =>
    (
      await buildPreviewDetail(
        probeScopeFor(context),
        recipe,
        input,
        await deps.resolveGuard(context),
        artifact
      )
    ).preview;

  const assertAvailable = (preview: InstallRecipePreview): void => {
    if (!preview.guard.allowed) throw new InstallBlockedError(preview);
    if (!preview.supported) {
      throw new InstallUnavailableError(
        preview,
        `Recipe ${preview.id} is not supported on this platform.`
      );
    }
    if (!preview.runnable) {
      throw new InstallUnavailableError(
        preview,
        `Recipe ${preview.id} has no automated run (${preview.unrunnableReason ?? 'unrunnable'}).`
      );
    }
    if (preview.missingRequirements.length > 0) {
      throw new InstallUnavailableError(
        preview,
        `Recipe ${preview.id} requires ${preview.missingRequirements.join(', ')}.`
      );
    }
  };

  const cleanupPreparation = async (preparation: PreparedInstall): Promise<void> => {
    preparations.delete(preparation.id);
    try {
      await preparation.artifact.cleanup();
    } catch {
      // A stale temp directory must never fail the request that swept it.
    }
  };

  const cleanupExpiredPreparations = async (): Promise<void> => {
    const now = deps.now();
    const expired = [...preparations.values()].filter(
      (preparation) => preparation.expiresAt <= now
    );
    await Promise.all(expired.map(cleanupPreparation));
  };

  const rememberStream = (runId: string, userId: string, stream: EventBuffer): void => {
    recentStreams.set(runId, { userId, stream });
    if (recentStreams.size <= MAX_RECENT_STREAMS) return;
    for (const [candidateId, candidate] of recentStreams) {
      if (!candidate.stream.closed || activeByRun.has(candidateId)) continue;
      recentStreams.delete(candidateId);
      if (recentStreams.size <= MAX_RECENT_STREAMS) break;
    }
  };

  const publishProbes = async (
    scope: ProbeScope,
    recipe: InstallRecipe,
    stream: EventBuffer
  ): Promise<void> => {
    const publish = (
      target: InstallProbeEvent['target'],
      status: RuntimeStatus | VersionManagerStatus | AgentCliStatus | null
    ) => {
      if (status) stream.publish({ type: 'probe', target, status, done: false });
    };

    // Which surfaces to refresh is the recipe's declaration, never a branch
    // on its id here. Every one runs through the same forced probe the reset
    // above set up, so the epoch guard still decides what may reach the cache.
    // A failed target is logged and skipped so a later declared surface still
    // refreshes — one detection service going down must not leave the rest stale.
    for (const target of recipe.probe) {
      try {
        switch (target.kind) {
          case 'runtime':
            publish(
              target.kind,
              await deps.probingService.getRuntimeStatus(scope, target.runtimeId, { force: true })
            );
            break;
          case 'version-manager':
            publish(
              target.kind,
              await deps.probingService.getVersionManagerStatus(scope, target.versionManagerId, {
                force: true,
              })
            );
            break;
          case 'agent':
            publish(
              target.kind,
              await deps.probingService.getAgentCliStatus(scope, target.targetId, { force: true })
            );
            break;
          default: {
            const unreachable: never = target;
            throw new Error(`Unhandled install probe target: ${JSON.stringify(unreachable)}`);
          }
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'Unknown probe failure.';
        stream.publish({
          type: 'log',
          stream: 'system',
          line: `Post-install probe failed: ${detail}`,
          done: false,
        });
      }
    }
  };

  /**
   * The terminal audit write must never change the outcome it records: a run
   * that exited 0 still succeeded if the row could not be updated. On failure
   * the row is left `running` for `settleOrphanedRun` to pick up, and the
   * problem is reported on the stream instead of being raised into the
   * execution catch, where it would be recorded as an execution failure.
   */
  const recordTerminal = async (
    active: ActiveInstall,
    result: CompleteInstallRun
  ): Promise<void> => {
    try {
      await deps.repository.complete(active.runId, active.userId, active.profileId, result);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown persistence failure.';
      active.stream.publish({
        type: 'log',
        stream: 'system',
        line: `Install audit row was not updated: ${detail}`,
        done: false,
      });
    }
  };

  const executeRun = async (
    scope: ProbeScope,
    active: ActiveInstall,
    recipe: InstallRecipe,
    argv: readonly string[],
    recipeEnv: Readonly<Record<string, string>>,
    artifact: InstallerArtifact | undefined
  ): Promise<void> => {
    try {
      const toolchain = await deps.toolchain.resolve(scope.userId, scope.environmentId);
      const result = await deps.runner.run(
        {
          runId: active.runId,
          userId: active.userId,
          environmentId: scope.environmentId,
          argv,
          env: recipeEnv,
          timeoutMs: recipe.timeoutMs,
          ...(recipe.acceptedExitCodes && { acceptedExitCodes: recipe.acceptedExitCodes }),
          toolchain,
        },
        {
          signal: active.abortController.signal,
          onLog: (event) => {
            active.stream.publish({
              type: 'log',
              stream: event.stream,
              line: event.line,
              done: false,
            });
          },
        }
      );
      await recordTerminal(active, result);
      // Drop in-flight and cached probes before the post-install force, so
      // that walk cannot join a scan that began against pre-install state.
      deps.probingService.resetCache(scope.environmentId);
      await publishProbes(scope, recipe, active.stream);
      active.stream.publish({
        type: 'exit',
        code: result.exitCode,
        status: result.status,
        truncated: result.truncated,
        durationMs: result.durationMs,
        done: true,
      });
    } catch (error) {
      // The runner reports a failed spawn through its own terminal status, so a
      // throw here is an unexpected execution failure — not evidence that the
      // installer never started. Recording `spawn-failed` would make the audit
      // trail wrong in exactly the case where it has to be trusted.
      await recordTerminal(active, {
        finishedAt: deps.now(),
        exitCode: null,
        status: 'failed',
        truncated: false,
      });
      active.stream.publish({
        type: 'error',
        error: error instanceof Error ? error.message : 'Install execution failed.',
        code: ERROR_CODES.INTERNAL,
        done: true,
      });
    } finally {
      active.stream.close();
      activeByRun.delete(active.runId);
      const key = activityKey(active.environmentId, active.recipeId);
      if (activeByRecipe.get(key)?.runId === active.runId) {
        activeByRecipe.delete(key);
      }
      try {
        await artifact?.cleanup();
      } catch {
        // A temp cleanup failure must not reject the detached execution task.
      }
    }
  };

  /**
   * A run is `running` only while this process holds it in memory, so a
   * `running` row with no in-memory owner outlived the process that spawned it.
   * Such a row can never complete, be cancelled, or produce a terminal stream
   * event, so it is settled on the next read instead of being left pending
   * forever. The outcome is genuinely unknown, which is what `interrupted`
   * reports — the installer may well have finished.
   */
  const settleOrphanedRun = async (
    run: InstallRun,
    userId: string,
    profileId: string
  ): Promise<InstallRun> => {
    if (run.status !== 'running' || activeByRun.has(run.id)) return run;
    const finishedAt = run.finishedAt ?? deps.now();
    try {
      await deps.repository.complete(run.id, userId, profileId, {
        finishedAt,
        exitCode: run.exitCode,
        status: 'interrupted',
        truncated: run.truncated,
      });
    } catch {
      // Reporting the honest status matters more than persisting it, and the
      // next read of this row retries the update.
    }
    return { ...run, finishedAt, status: 'interrupted' };
  };

  const historicalStream = async function* (run: InstallRun): AsyncIterable<InstallStreamEvent> {
    try {
      const content = await deps.readLog(deps.getLogPath(run.id));
      for (const line of content.split(/\r?\n/)) {
        if (!line) continue;
        yield { type: 'log', stream: 'system', line, done: false };
      }
    } catch {
      // The audit row remains useful even if its bounded log was removed.
    }
    // Always terminal. A replay that ends without a `done` frame leaves the
    // client waiting on an EventSource that will never produce another event.
    yield {
      type: 'exit',
      code: run.exitCode,
      status: run.status === 'running' ? 'interrupted' : run.status,
      truncated: run.truncated,
      durationMs: terminalDuration(run),
      done: true,
    };
  };

  return {
    async listRecipes(context) {
      // The guard does not vary per recipe, so it is resolved once instead of
      // re-reading config and probing the container marker for every preview.
      const guard = await deps.resolveGuard(context);
      const scope = probeScopeFor(context);
      const details = await Promise.all(
        deps.recipes.map((recipe) => buildPreviewDetail(scope, recipe, defaultInput(recipe), guard))
      );
      return details.map((detail) => detail.preview);
    },

    async prepare(body, requestContext) {
      const context = withEnvironment(requestContext, body.environmentId);
      assertRequestedProfileId(body.profileId, context);
      await cleanupExpiredPreparations();
      const recipe = resolveRecipe(body.recipeId);
      const scope = probeScopeFor(context);
      const initial = await buildPreviewDetail(
        scope,
        recipe,
        body.input,
        await deps.resolveGuard(context)
      );
      assertAvailable(initial.preview);

      const download = recipe.download?.[initial.platform];
      if (!download) {
        return {
          preparationId: null,
          expiresAt: null,
          recipe: initial.preview,
        };
      }

      const artifact = await deps.downloader.download(
        download,
        context.signal ? { signal: context.signal } : undefined
      );
      try {
        if (context.signal?.aborted) {
          throw new InstallPreparationError('Installer preparation was cancelled.');
        }
        const prepared = await buildPreviewDetail(
          scope,
          recipe,
          body.input,
          await deps.resolveGuard(context),
          artifact
        );
        assertAvailable(prepared.preview);
        const matchingPreparations = [...preparations.values()].filter(
          (candidate) =>
            candidate.userId === context.userId &&
            candidate.recipeId === recipe.id &&
            candidate.inputKey === recipeInputKey(body.input)
        );
        await Promise.all(matchingPreparations.map(cleanupPreparation));

        const preparation: PreparedInstall = {
          id: deps.generateId(),
          userId: context.userId,
          recipeId: recipe.id,
          inputKey: recipeInputKey(body.input),
          expiresAt: deps.now() + PREPARATION_TTL_MS,
          artifact,
        };
        preparations.set(preparation.id, preparation);
        return {
          preparationId: preparation.id,
          expiresAt: preparation.expiresAt,
          recipe: prepared.preview,
        };
      } catch (error) {
        await artifact.cleanup().catch(() => undefined);
        throw error;
      }
    },

    async start(body, requestContext) {
      const context = withEnvironment(requestContext, body.environmentId);
      assertRequestedProfileId(body.profileId, context);
      await cleanupExpiredPreparations();
      const recipe = resolveRecipe(body.recipeId);
      const preview = await buildPreview(recipe, body.input, context);
      assertAvailable(preview);

      const environmentId = environmentIdOf(context);
      const key = activityKey(environmentId, recipe.id);
      const existing = activeByRecipe.get(key);
      if (existing) {
        if (existing.userId !== context.userId) {
          throw new InstallConflictError(`Recipe ${recipe.id} is already running.`);
        }
        return { runId: existing.runId, attached: true };
      }

      const starting = startingByRecipe.get(key);
      if (starting) {
        if (starting.userId !== context.userId) {
          throw new InstallConflictError(`Recipe ${recipe.id} is already starting.`);
        }
        const result = await starting.promise;
        return { ...result, attached: true };
      }

      const startPromise = (async (): Promise<InstallStartResponse> => {
        let artifact: InstallerArtifact | undefined;
        if (recipe.download) {
          const preparation = body.preparationId ? preparations.get(body.preparationId) : undefined;
          if (
            !preparation ||
            preparation.userId !== context.userId ||
            preparation.recipeId !== recipe.id ||
            preparation.inputKey !== recipeInputKey(body.input)
          ) {
            throw new InstallPreparationError(
              'A current preparation for this recipe and input is required.'
            );
          }
          preparations.delete(preparation.id);
          artifact = preparation.artifact;
        }

        try {
          const execution = await buildPreviewDetail(
            probeScopeFor(context),
            recipe,
            body.input,
            await deps.resolveGuard(context),
            artifact
          );
          assertAvailable(execution.preview);
          const { requirements, platform } = execution;
          // `runnable` was just asserted above, so `recipe.argv` is defined;
          // the fallback keeps this a type-safe read rather than a cast.
          const argv = recipe.argv
            ? recipe.argv(body.input, {
                ...(artifact && { installerPath: artifact.path }),
                ...(requirements.nvmDir && { nvmDir: requirements.nvmDir }),
                platform,
                binaryPaths: requirements.binaryPaths,
              })
            : [];
          const recipeEnv = {
            ...recipe.env,
            ...(requirements.nvmDir && { NVM_DIR: requirements.nvmDir }),
          };
          // The install outlives the request that starts it: the response is a
          // run id and the log arrives on a separate stream. Binding the child
          // to `context.signal` would let a closed tab SIGKILL an installer
          // mid-write, and third-party installers have no rollback. Once the
          // child is spawned, cancellation belongs to POST /:runId/cancel.
          if (context.signal?.aborted) {
            throw new InstallPreparationError('Install request was cancelled before it started.');
          }

          const runId = deps.generateId();
          const startedAt = deps.now();
          const profileId = resolveActiveProfileId(context);
          const active: ActiveInstall = {
            runId,
            userId: context.userId,
            profileId,
            recipeId: recipe.id,
            environmentId,
            abortController: new AbortController(),
            stream: createEventBuffer(),
          };

          // Registered before the audit row exists so a concurrent read can
          // never see a `running` row that this process does not yet own and
          // mistake it for one orphaned by a restart.
          activeByRecipe.set(key, active);
          activeByRun.set(runId, active);
          try {
            await deps.repository.create({
              id: runId,
              userId: context.userId,
              profileId,
              recipeId: recipe.id,
              argv,
              startedAt,
            });
          } catch (error) {
            activeByRecipe.delete(key);
            activeByRun.delete(runId);
            throw error;
          }

          rememberStream(runId, context.userId, active.stream);
          void executeRun(probeScopeFor(context), active, recipe, argv, recipeEnv, artifact);
          return { runId, attached: false };
        } catch (error) {
          await artifact?.cleanup().catch(() => undefined);
          throw error;
        }
      })();
      startingByRecipe.set(key, { userId: context.userId, promise: startPromise });
      try {
        return await startPromise;
      } finally {
        if (startingByRecipe.get(key)?.promise === startPromise) {
          startingByRecipe.delete(key);
        }
      }
    },

    async cancel(runId, userId) {
      const profileId = resolveActiveProfileId({ userId });
      const run = await deps.repository.find(runId, userId, profileId);
      if (!run) return null;
      const active = activeByRun.get(runId);
      if (!active || active.userId !== userId) {
        // There is no child to signal. If the row still claims to be running it
        // belongs to a process that no longer exists, so settle it here rather
        // than report a cancellation that can never be honoured.
        await settleOrphanedRun(run, userId, profileId);
        return { runId, cancellationRequested: false };
      }
      active.abortController.abort('user_cancelled');
      return { runId, cancellationRequested: true };
    },

    async listRuns(userId) {
      const profileId = resolveActiveProfileId({ userId });
      const runs = await deps.repository.list(userId, profileId);
      return Promise.all(runs.map((run) => settleOrphanedRun(run, userId, profileId)));
    },

    async getRunStream(runId, userId) {
      const profileId = resolveActiveProfileId({ userId });
      const run = await deps.repository.find(runId, userId, profileId);
      if (!run) return null;
      const recent = recentStreams.get(runId);
      if (recent?.userId === userId) return recent.stream.subscribe();
      return historicalStream(await settleOrphanedRun(run, userId, profileId));
    },
  };
}

export const installService = createInstallService();
