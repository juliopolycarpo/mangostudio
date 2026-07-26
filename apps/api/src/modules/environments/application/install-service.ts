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
import { ERROR_CODES } from '@mangostudio/shared/errors';
import { getConfig } from '../../../lib/config';
import { getInstallLogPath } from '../../../lib/mango-paths';
import { isStandaloneExecutable } from '../../../lib/runtime-paths';
import { generateId } from '../../../utils/id';
import { detectContainer, evaluateInstallGuard } from '../domain/install-guards';
import { INSTALL_RECIPES, type InstallRecipe } from '../domain/install-recipes';
import { assertRecipeInput } from '../domain/recipe-input';
import {
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
import { type AgentCliDetectionService, agentCliDetectionService } from './agent-cli-detection';
import { type RuntimeDetectionService, runtimeDetectionService } from './runtime-detection';
import {
  type VersionManagerDetectionService,
  versionManagerDetectionService,
} from './version-manager-detection';

const PREPARATION_TTL_MS = 10 * 60 * 1000;
const MAX_RECENT_STREAMS = 20;

export interface InstallRequestContext {
  readonly userId: string;
  readonly clientIp: string | undefined;
  readonly signal?: AbortSignal;
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
  readonly recipeId: InstallRecipeId;
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
}

interface InstallServiceDeps {
  readonly recipes: readonly InstallRecipe[];
  readonly runtimeService: RuntimeDetectionService;
  readonly versionManagerService: VersionManagerDetectionService;
  readonly agentService: AgentCliDetectionService;
  readonly repository: InstallRunRepository;
  readonly downloader: InstallerDownloader;
  readonly runner: InstallRunner;
  readonly now: () => number;
  readonly generateId: () => string;
  readonly platform: string;
  readonly getLogPath: (runId: string) => string;
  readonly readLog: (path: string) => Promise<string>;
  readonly inspectProfileSetup: ProfileSetupInspector;
  readonly resolveGuard: (clientIp: string | undefined) => InstallGuard;
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

function defaultGuard(clientIp: string | undefined): InstallGuard {
  const config = getConfig();
  return evaluateInstallGuard({
    serverHost: config.server.host,
    clientIp,
    installsEnabled: config.environments.installsEnabled,
    standalone: isStandaloneExecutable(),
    container: detectContainer(),
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

function terminalDuration(run: InstallRun): number {
  return Math.max(0, (run.finishedAt ?? run.startedAt) - run.startedAt);
}

function isInstallPlatform(platform: string): platform is InstallPlatform {
  return platform === 'darwin' || platform === 'linux';
}

export function createInstallService(overrides: Partial<InstallServiceDeps> = {}): InstallService {
  const deps: InstallServiceDeps = {
    recipes: INSTALL_RECIPES,
    runtimeService: runtimeDetectionService,
    versionManagerService: versionManagerDetectionService,
    agentService: agentCliDetectionService,
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
  const recipesById = new Map(deps.recipes.map((recipe) => [recipe.id, recipe] as const));
  const preparations = new Map<string, PreparedInstall>();
  const activeByRecipe = new Map<InstallRecipeId, ActiveInstall>();
  const activeByRun = new Map<string, ActiveInstall>();
  const recentStreams = new Map<string, RecentInstallStream>();
  const startingByRecipe = new Map<InstallRecipeId, StartingInstall>();

  const resolveRecipe = (id: InstallRecipeId): InstallRecipe => {
    // Only the configured recipe set is executable. Falling back to the global
    // registry would let a restricted service run a recipe it does not expose.
    const recipe = recipesById.get(id);
    if (!recipe) throw new Error(`Missing install recipe "${id}".`);
    return recipe;
  };

  const resolveRequirement = async (
    requirement: RuntimeId
  ): Promise<{ available: boolean; nvmDir?: string }> => {
    if (requirement === 'nvm') {
      const status = await deps.versionManagerService.getVersionManagerStatus('nvm');
      return {
        available: status?.installed === true,
        ...(status?.root && { nvmDir: status.root }),
      };
    }
    const status = await deps.runtimeService.getRuntimeStatus(requirement);
    return { available: Boolean(status && status.installations.length > 0) };
  };

  const inspectRequirements = async (recipe: InstallRecipe): Promise<RecipeRequirements> => {
    const missing: RuntimeId[] = [];
    let nvmDir: string | undefined;
    for (const requirement of recipe.requires) {
      const result = await resolveRequirement(requirement);
      if (!result.available) missing.push(requirement);
      if (result.nvmDir) nvmDir = result.nvmDir;
    }
    return { missing, ...(nvmDir && { nvmDir }) };
  };

  /**
   * Builds a preview and returns the requirement inspection that produced it so
   * callers that also need the resolved `nvmDir` do not re-run detection.
   */
  const buildPreviewDetail = async (
    recipe: InstallRecipe,
    input: RecipeInput,
    guard: InstallGuard,
    artifact?: InstallerArtifact
  ): Promise<{ preview: InstallRecipePreview; requirements: RecipeRequirements }> => {
    assertRecipeInput(input, recipe.inputKind);
    const requirements = await inspectRequirements(recipe);
    const profileSetup: InstallProfileSetup | undefined = recipe.profileLines
      ? await deps.inspectProfileSetup(recipe.profileLines)
      : undefined;
    const supported = isInstallPlatform(deps.platform) && recipe.platforms.includes(deps.platform);
    const argv = recipe.argv(input, {
      ...(recipe.download && {
        installerPath: artifact?.path ?? '<downloaded-installer>',
      }),
      ...(requirements.nvmDir && { nvmDir: requirements.nvmDir }),
      ...(!requirements.nvmDir && recipe.requires.includes('nvm') && { nvmDir: '$NVM_DIR' }),
    });

    return {
      requirements,
      preview: {
        id: recipe.id,
        runtimeId: recipe.runtimeId,
        action: recipe.action,
        inputKind: recipe.inputKind,
        platforms: [...recipe.platforms],
        argv: [...argv],
        copyCommand: recipe.copyCommand(input),
        requires: [...recipe.requires],
        writes: [...recipe.writes],
        networkAccess: recipe.networkAccess,
        timeoutMs: recipe.timeoutMs,
        supported,
        missingRequirements: requirements.missing,
        guard,
        ...(recipe.download && {
          download: {
            url: artifact?.url ?? recipe.download.url,
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
    (await buildPreviewDetail(recipe, input, deps.resolveGuard(context.clientIp), artifact))
      .preview;

  const assertAvailable = (preview: InstallRecipePreview): void => {
    if (!preview.guard.allowed) throw new InstallBlockedError(preview);
    if (!preview.supported) {
      throw new InstallUnavailableError(
        preview,
        `Recipe ${preview.id} is not supported on ${deps.platform}.`
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

  const publishProbes = async (recipe: InstallRecipe, stream: EventBuffer): Promise<void> => {
    const publish = (
      target: InstallProbeEvent['target'],
      status: RuntimeStatus | VersionManagerStatus | AgentCliStatus | null
    ) => {
      if (status) stream.publish({ type: 'probe', target, status, done: false });
    };

    try {
      if (recipe.runtimeId === 'nvm') {
        publish(
          'version-manager',
          await deps.versionManagerService.getVersionManagerStatus('nvm', { force: true })
        );
        return;
      }
      if (
        recipe.runtimeId === 'claude' ||
        recipe.runtimeId === 'codex' ||
        recipe.runtimeId === 'cursor'
      ) {
        publish(
          'agent',
          await deps.agentService.getAgentCliStatus(recipe.runtimeId, { force: true })
        );
        return;
      }

      publish(
        'runtime',
        await deps.runtimeService.getRuntimeStatus(recipe.runtimeId, { force: true })
      );
      if (recipe.requires.includes('nvm')) {
        publish(
          'version-manager',
          await deps.versionManagerService.getVersionManagerStatus('nvm', { force: true })
        );
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
  };

  const executeRun = async (
    active: ActiveInstall,
    recipe: InstallRecipe,
    argv: readonly string[],
    recipeEnv: Readonly<Record<string, string>>,
    artifact: InstallerArtifact | undefined
  ): Promise<void> => {
    try {
      const result = await deps.runner.run(
        {
          argv,
          env: recipeEnv,
          timeoutMs: recipe.timeoutMs,
          logPath: deps.getLogPath(active.runId),
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
      await deps.repository.complete(active.runId, active.userId, result);
      await publishProbes(recipe, active.stream);
      active.stream.publish({
        type: 'exit',
        code: result.exitCode,
        status: result.status,
        truncated: result.truncated,
        durationMs: result.durationMs,
        done: true,
      });
    } catch (error) {
      const finishedAt = deps.now();
      try {
        await deps.repository.complete(active.runId, active.userId, {
          finishedAt,
          exitCode: null,
          status: 'spawn-failed',
          truncated: false,
        });
      } catch {
        // Preserve the original execution failure in the stream. The initial
        // audit row remains as evidence if its terminal update also fails.
      }
      active.stream.publish({
        type: 'error',
        error: error instanceof Error ? error.message : 'Install execution failed.',
        code: ERROR_CODES.INTERNAL,
        done: true,
      });
    } finally {
      active.stream.close();
      activeByRun.delete(active.runId);
      if (activeByRecipe.get(active.recipeId)?.runId === active.runId) {
        activeByRecipe.delete(active.recipeId);
      }
      try {
        await artifact?.cleanup();
      } catch {
        // A temp cleanup failure must not reject the detached execution task.
      }
    }
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
    if (run.status !== 'running') {
      yield {
        type: 'exit',
        code: run.exitCode,
        status: run.status,
        truncated: run.truncated,
        durationMs: terminalDuration(run),
        done: true,
      };
    }
  };

  return {
    async listRecipes(context) {
      // The guard does not vary per recipe, so it is resolved once instead of
      // re-reading config and probing the container marker for every preview.
      const guard = deps.resolveGuard(context.clientIp);
      const details = await Promise.all(
        deps.recipes.map((recipe) => buildPreviewDetail(recipe, defaultInput(recipe), guard))
      );
      return details.map((detail) => detail.preview);
    },

    async prepare(body, context) {
      await cleanupExpiredPreparations();
      const recipe = resolveRecipe(body.recipeId);
      const preview = await buildPreview(recipe, body.input, context);
      assertAvailable(preview);

      if (!recipe.download) {
        return {
          preparationId: null,
          expiresAt: null,
          recipe: preview,
        };
      }

      const artifact = await deps.downloader.download(
        recipe.download,
        context.signal ? { signal: context.signal } : undefined
      );
      try {
        if (context.signal?.aborted) {
          throw new InstallPreparationError('Installer preparation was cancelled.');
        }
        const preparedPreview = await buildPreview(recipe, body.input, context, artifact);
        assertAvailable(preparedPreview);
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
          recipe: preparedPreview,
        };
      } catch (error) {
        await artifact.cleanup().catch(() => undefined);
        throw error;
      }
    },

    async start(body, context) {
      await cleanupExpiredPreparations();
      const recipe = resolveRecipe(body.recipeId);
      const preview = await buildPreview(recipe, body.input, context);
      assertAvailable(preview);

      const existing = activeByRecipe.get(recipe.id);
      if (existing) {
        if (existing.userId !== context.userId) {
          throw new InstallConflictError(`Recipe ${recipe.id} is already running.`);
        }
        return { runId: existing.runId, attached: true };
      }

      const starting = startingByRecipe.get(recipe.id);
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
            recipe,
            body.input,
            deps.resolveGuard(context.clientIp),
            artifact
          );
          assertAvailable(execution.preview);
          const { requirements } = execution;
          const argv = recipe.argv(body.input, {
            ...(artifact && { installerPath: artifact.path }),
            ...(requirements.nvmDir && { nvmDir: requirements.nvmDir }),
          });
          const recipeEnv = {
            ...recipe.env,
            ...(requirements.nvmDir && { NVM_DIR: requirements.nvmDir }),
          };
          const runId = deps.generateId();
          const startedAt = deps.now();

          await deps.repository.create({
            id: runId,
            userId: context.userId,
            recipeId: recipe.id,
            argv,
            startedAt,
          });

          const active: ActiveInstall = {
            runId,
            userId: context.userId,
            recipeId: recipe.id,
            abortController: new AbortController(),
            stream: createEventBuffer(),
          };
          const abortFromRequest = () => active.abortController.abort('request_cancelled');
          if (context.signal?.aborted) {
            abortFromRequest();
          } else {
            context.signal?.addEventListener('abort', abortFromRequest, { once: true });
          }

          activeByRecipe.set(recipe.id, active);
          activeByRun.set(runId, active);
          rememberStream(runId, context.userId, active.stream);
          void executeRun(active, recipe, argv, recipeEnv, artifact).finally(() => {
            context.signal?.removeEventListener('abort', abortFromRequest);
          });
          return { runId, attached: false };
        } catch (error) {
          await artifact?.cleanup().catch(() => undefined);
          throw error;
        }
      })();
      startingByRecipe.set(recipe.id, { userId: context.userId, promise: startPromise });
      try {
        return await startPromise;
      } finally {
        if (startingByRecipe.get(recipe.id)?.promise === startPromise) {
          startingByRecipe.delete(recipe.id);
        }
      }
    },

    async cancel(runId, userId) {
      const run = await deps.repository.find(runId, userId);
      if (!run) return null;
      const active = activeByRun.get(runId);
      if (!active || active.userId !== userId) {
        return { runId, cancellationRequested: false };
      }
      active.abortController.abort('user_cancelled');
      return { runId, cancellationRequested: true };
    },

    listRuns(userId) {
      return deps.repository.list(userId);
    },

    async getRunStream(runId, userId) {
      const run = await deps.repository.find(runId, userId);
      if (!run) return null;
      const recent = recentStreams.get(runId);
      if (recent?.userId === userId) return recent.stream.subscribe();
      return historicalStream(run);
    },
  };
}

export const installService = createInstallService();
