import { describe, expect, it } from 'bun:test';
import type { InstallGuard, InstallRun, RuntimeStatus } from '@mangostudio/shared/environments';
import {
  createInstallService,
  InstallBlockedError,
  InstallPreparationError,
} from '../../../../src/modules/environments/application/install-service';
import type { EnvironmentProbingService } from '../../../../src/modules/environments/application/probing-service';
import { getInstallRecipe } from '../../../../src/modules/environments/domain/install-recipes';
import type { InstallRunRepository } from '../../../../src/modules/environments/infrastructure/install-run-repository';
import type { InstallRunner } from '../../../../src/modules/environments/infrastructure/install-runner';
import type {
  InstallerArtifact,
  InstallerDownloader,
} from '../../../../src/modules/environments/infrastructure/installer-download';

const ALLOWED_GUARD: InstallGuard = { allowed: true, reasons: [] };
const BLOCKED_GUARD: InstallGuard = { allowed: false, reasons: ['disabled'] };
const REQUEST_CONTEXT = {
  userId: 'install-user',
  clientIp: '127.0.0.1',
} as const;
const NO_INPUT = { kind: 'none' } as const;
const BUN_INSTALLATION = {
  path: '/home/tester/.bun/bin/bun',
  rawPath: '/home/tester/.bun/bin/bun',
  version: '1.3.0',
  origin: 'path',
  pathIndex: 0,
  effective: true,
} as const;
const BUN_STATUS: RuntimeStatus = {
  id: 'bun',
  health: 'ok',
  installations: [BUN_INSTALLATION],
  effective: BUN_INSTALLATION,
  findings: [],
  installable: true,
  probedAtMs: 1_700_000_000_000,
};

function createDetectionServices() {
  let forcedRuntimeProbes = 0;
  const probingService: EnvironmentProbingService = {
    listRuntimeStatuses: () => Promise.resolve([BUN_STATUS]),
    getRuntimeStatus: (_scope, id, options) => {
      if (options?.force) forcedRuntimeProbes += 1;
      return Promise.resolve(id === 'bun' ? BUN_STATUS : null);
    },
    listVersionManagerStatuses: () => Promise.resolve([]),
    getVersionManagerStatus: () => Promise.resolve(null),
    listAgentCliStatuses: () => Promise.resolve([]),
    getAgentCliStatus: () => Promise.resolve(null),
    listLocationStatuses: () => Promise.resolve([]),
    resetCache: () => undefined,
  };
  return {
    probingService,
    getForcedRuntimeProbes: () => forcedRuntimeProbes,
  };
}

function createMemoryRepository() {
  const runs = new Map<string, InstallRun>();
  const repository: InstallRunRepository = {
    create(input) {
      const run: InstallRun = {
        id: input.id,
        recipeId: input.recipeId,
        argv: [...input.argv],
        startedAt: input.startedAt,
        finishedAt: null,
        exitCode: null,
        status: 'running',
        truncated: false,
      };
      runs.set(run.id, run);
      return Promise.resolve(run);
    },
    complete(id, userId, _profileId, result) {
      if (userId !== REQUEST_CONTEXT.userId) return Promise.resolve();
      const run = runs.get(id);
      if (run) runs.set(id, { ...run, ...result });
      return Promise.resolve();
    },
    find(id, userId, _profileId) {
      return Promise.resolve(userId === REQUEST_CONTEXT.userId ? (runs.get(id) ?? null) : null);
    },
    list(userId, _profileId) {
      return Promise.resolve(userId === REQUEST_CONTEXT.userId ? [...runs.values()] : []);
    },
  };
  return { repository, runs };
}

function deferredRunner() {
  let finish: (() => void) | undefined;
  const runner: InstallRunner = {
    run(_command, options) {
      options?.onLog?.({ stream: 'stdout', line: 'hello' });
      return new Promise((resolve) => {
        finish = () =>
          resolve({
            exitCode: 0,
            status: 'succeeded',
            truncated: false,
            finishedAt: 1_700_000_001_000,
            durationMs: 1000,
          });
      });
    },
  };
  return {
    runner,
    finish: () => {
      if (!finish) throw new Error('Runner was not started.');
      finish();
    },
  };
}

async function collectEvents(
  source: AsyncIterable<unknown> | null
): Promise<Record<string, unknown>[]> {
  if (!source) return [];
  const events: Record<string, unknown>[] = [];
  for await (const event of source) events.push(event as Record<string, unknown>);
  return events;
}

describe('install service', () => {
  it('attaches duplicate starts, streams output, records the result, and re-probes', async () => {
    const detection = createDetectionServices();
    const memory = createMemoryRepository();
    const controlled = deferredRunner();
    let nextId = 0;
    const service = createInstallService({
      recipes: [getInstallRecipe('bun.update')],
      ...detection,
      repository: memory.repository,
      runner: controlled.runner,
      resolveGuard: () => Promise.resolve(ALLOWED_GUARD),
      generateId: () => {
        nextId += 1;
        return `run-${nextId}`;
      },
      now: () => 1_700_000_000_000,
      platform: 'linux',
    });

    const body = { recipeId: 'bun.update', input: NO_INPUT } as const;
    const started = await service.start(body, REQUEST_CONTEXT);
    const duplicate = await service.start(body, REQUEST_CONTEXT);
    const eventsPromise = collectEvents(
      await service.getRunStream(started.runId, REQUEST_CONTEXT.userId)
    );

    expect(started).toEqual({ runId: 'run-1', attached: false });
    expect(duplicate).toEqual({ runId: 'run-1', attached: true });

    controlled.finish();
    const events = await eventsPromise;
    expect(events).toContainEqual({
      type: 'log',
      stream: 'stdout',
      line: 'hello',
      done: false,
    });
    expect(events).toContainEqual({
      type: 'probe',
      target: 'runtime',
      status: BUN_STATUS,
      done: false,
    });
    expect(events.at(-1)).toEqual({
      type: 'exit',
      code: 0,
      status: 'succeeded',
      truncated: false,
      durationMs: 1000,
      done: true,
    });
    expect(detection.getForcedRuntimeProbes()).toBe(1);
    expect(memory.runs.get(started.runId)?.status).toBe('succeeded');
  });

  it('coalesces starts that overlap before execution becomes active', async () => {
    const detection = createDetectionServices();
    const memory = createMemoryRepository();
    let releaseCreate: () => void = () => undefined;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let createCalls = 0;
    const repository: InstallRunRepository = {
      ...memory.repository,
      async create(input) {
        createCalls += 1;
        await createGate;
        return memory.repository.create(input);
      },
    };
    let runnerCalls = 0;
    const runner: InstallRunner = {
      run() {
        runnerCalls += 1;
        return Promise.resolve({
          exitCode: 0,
          status: 'succeeded',
          truncated: false,
          finishedAt: 1_700_000_001_000,
          durationMs: 1000,
        });
      },
    };
    let nextId = 0;
    const service = createInstallService({
      recipes: [getInstallRecipe('bun.update')],
      ...detection,
      repository,
      runner,
      resolveGuard: () => Promise.resolve(ALLOWED_GUARD),
      generateId: () => {
        nextId += 1;
        return `overlap-run-${nextId}`;
      },
      now: () => 1_700_000_000_000,
      platform: 'linux',
    });
    const body = { recipeId: 'bun.update', input: NO_INPUT } as const;

    const firstPromise = service.start(body, REQUEST_CONTEXT);
    const secondPromise = service.start(body, REQUEST_CONTEXT);
    while (createCalls === 0) await Promise.resolve();
    await Bun.sleep(0);
    releaseCreate();

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first).toEqual({ runId: 'overlap-run-1', attached: false });
    expect(second).toEqual({ runId: 'overlap-run-1', attached: true });
    expect(createCalls).toBe(1);
    expect(runnerCalls).toBe(1);
  });

  it('returns copy-command details while refusing execution when guards fail', async () => {
    const detection = createDetectionServices();
    const memory = createMemoryRepository();
    const service = createInstallService({
      recipes: [getInstallRecipe('bun.update')],
      ...detection,
      repository: memory.repository,
      resolveGuard: () => Promise.resolve(BLOCKED_GUARD),
      platform: 'linux',
    });

    const [preview] = await service.listRecipes(REQUEST_CONTEXT);

    expect(preview?.guard).toEqual(BLOCKED_GUARD);
    expect(preview?.argv).toEqual(['bun', 'upgrade']);
    expect(preview?.copyCommand).toBe('bun upgrade');
    await expect(
      service.start({ recipeId: 'bun.update', input: NO_INPUT }, REQUEST_CONTEXT)
    ).rejects.toBeInstanceOf(InstallBlockedError);
    expect(memory.runs.size).toBe(0);
  });

  it('reports the expected shell profile setup without modifying a profile', async () => {
    const detection = createDetectionServices();
    const memory = createMemoryRepository();
    const service = createInstallService({
      recipes: [getInstallRecipe('bun.install.official')],
      ...detection,
      repository: memory.repository,
      resolveGuard: () => Promise.resolve(ALLOWED_GUARD),
      inspectProfileSetup: (lines) =>
        Promise.resolve({
          lines: [...lines],
          present: true,
          detectedIn: ['/home/tester/.zshrc'],
        }),
      platform: 'linux',
    });

    const [preview] = await service.listRecipes(REQUEST_CONTEXT);

    expect(preview?.profileSetup).toEqual({
      lines: ['export BUN_INSTALL="$HOME/.bun"', 'export PATH="$BUN_INSTALL/bin:$PATH"'],
      present: true,
      detectedIn: ['/home/tester/.zshrc'],
    });
  });

  it('binds downloaded artifacts to one preparation and cleans replaced artifacts', async () => {
    const detection = createDetectionServices();
    const memory = createMemoryRepository();
    const cleaned: string[] = [];
    let artifactNumber = 0;
    const downloader: InstallerDownloader = {
      download() {
        artifactNumber += 1;
        const id = `artifact-${artifactNumber}`;
        const artifact: InstallerArtifact = {
          path: `/tmp/${id}/installer.sh`,
          url: 'https://example.test/install.sh',
          sizeBytes: 512,
          sha256: 'a'.repeat(64),
          cleanup: () => {
            cleaned.push(id);
            return Promise.resolve();
          },
        };
        return Promise.resolve(artifact);
      },
    };
    const runner: InstallRunner = {
      run() {
        return Promise.resolve({
          exitCode: 0,
          status: 'succeeded',
          truncated: false,
          finishedAt: 1_700_000_001_000,
          durationMs: 1000,
        });
      },
    };
    let nextId = 0;
    const service = createInstallService({
      recipes: [getInstallRecipe('bun.install.official')],
      ...detection,
      repository: memory.repository,
      downloader,
      runner,
      resolveGuard: () => Promise.resolve(ALLOWED_GUARD),
      generateId: () => {
        nextId += 1;
        return `id-${nextId}`;
      },
      now: () => 1_700_000_000_000,
      platform: 'linux',
    });
    const body = { recipeId: 'bun.install.official', input: NO_INPUT } as const;

    const first = await service.prepare(body, REQUEST_CONTEXT);
    const second = await service.prepare(body, REQUEST_CONTEXT);

    expect(first.recipe.download).toEqual({
      url: 'https://example.test/install.sh',
      sizeBytes: 512,
      sha256: 'a'.repeat(64),
    });
    expect(cleaned).toEqual(['artifact-1']);
    await expect(
      service.start({ ...body, preparationId: first.preparationId ?? undefined }, REQUEST_CONTEXT)
    ).rejects.toBeInstanceOf(InstallPreparationError);

    const started = await service.start(
      { ...body, preparationId: second.preparationId ?? undefined },
      REQUEST_CONTEXT
    );
    await collectEvents(await service.getRunStream(started.runId, REQUEST_CONTEXT.userId));
    expect(cleaned).toEqual(['artifact-1', 'artifact-2']);
  });

  it('releases a waiting stream subscriber when the client disconnects', async () => {
    const detection = createDetectionServices();
    const memory = createMemoryRepository();
    const controlled = deferredRunner();
    const service = createInstallService({
      recipes: [getInstallRecipe('bun.update')],
      ...detection,
      repository: memory.repository,
      runner: controlled.runner,
      resolveGuard: () => Promise.resolve(ALLOWED_GUARD),
      generateId: () => 'disconnect-run',
      now: () => 1_700_000_000_000,
      platform: 'linux',
    });

    const started = await service.start(
      { recipeId: 'bun.update', input: NO_INPUT },
      REQUEST_CONTEXT
    );
    const source = await service.getRunStream(started.runId, REQUEST_CONTEXT.userId);
    const iterator = source?.[Symbol.asyncIterator]();
    expect((await iterator?.next())?.value).toEqual({
      type: 'log',
      stream: 'stdout',
      line: 'hello',
      done: false,
    });

    const waiting = iterator?.next();
    const returned = iterator?.return?.();
    expect(await returned).toEqual({ done: true, value: undefined });
    expect(await waiting).toEqual({ done: true, value: undefined });

    controlled.finish();
  });

  it('keeps a started install alive when the starting request disconnects', async () => {
    const detection = createDetectionServices();
    const memory = createMemoryRepository();
    const controlled = deferredRunner();
    let runnerSignal: AbortSignal | undefined;
    const runner: InstallRunner = {
      run(command, options) {
        runnerSignal = options?.signal;
        return controlled.runner.run(command, options);
      },
    };
    const service = createInstallService({
      recipes: [getInstallRecipe('bun.update')],
      ...detection,
      repository: memory.repository,
      runner,
      resolveGuard: () => Promise.resolve(ALLOWED_GUARD),
      generateId: () => 'detached-run',
      now: () => 1_700_000_000_000,
      platform: 'linux',
    });

    const controller = new AbortController();
    const started = await service.start(
      { recipeId: 'bun.update', input: NO_INPUT },
      { ...REQUEST_CONTEXT, signal: controller.signal }
    );
    // The client closed the tab right after receiving its run id.
    controller.abort('client_disconnected');
    await Bun.sleep(0);
    expect(runnerSignal?.aborted).toBe(false);

    controlled.finish();
    const events = await collectEvents(
      await service.getRunStream(started.runId, REQUEST_CONTEXT.userId)
    );

    expect(events.at(-1)).toMatchObject({ type: 'exit', status: 'succeeded', done: true });
    expect(memory.runs.get('detached-run')?.status).toBe('succeeded');
  });

  it('settles a run orphaned by a restart and always ends its replay', async () => {
    const detection = createDetectionServices();
    const memory = createMemoryRepository();
    // A row left behind by a process that stopped mid-install: still `running`,
    // but no in-memory run owns it and nothing can ever complete it.
    memory.runs.set('orphan-run', {
      id: 'orphan-run',
      recipeId: 'bun.update',
      argv: ['bun', 'upgrade'],
      startedAt: 1_700_000_000_000,
      finishedAt: null,
      exitCode: null,
      status: 'running',
      truncated: false,
    });
    const service = createInstallService({
      recipes: [getInstallRecipe('bun.update')],
      ...detection,
      repository: memory.repository,
      resolveGuard: () => Promise.resolve(ALLOWED_GUARD),
      now: () => 1_700_000_005_000,
      readLog: () => Promise.resolve('resolving dependencies\n'),
      platform: 'linux',
    });

    const [listed] = await service.listRuns(REQUEST_CONTEXT.userId);
    expect(listed?.status).toBe('interrupted');
    expect(listed?.finishedAt).toBe(1_700_000_005_000);
    expect(memory.runs.get('orphan-run')?.status).toBe('interrupted');

    expect(await service.cancel('orphan-run', REQUEST_CONTEXT.userId)).toEqual({
      runId: 'orphan-run',
      cancellationRequested: false,
    });

    const events = await collectEvents(
      await service.getRunStream('orphan-run', REQUEST_CONTEXT.userId)
    );

    expect(events.at(-1)).toEqual({
      type: 'exit',
      code: null,
      status: 'interrupted',
      truncated: false,
      durationMs: 5000,
      done: true,
    });
  });

  it('records an execution failure without claiming the installer never started', async () => {
    const detection = createDetectionServices();
    const memory = createMemoryRepository();
    const runner: InstallRunner = {
      run: () => Promise.reject(new Error('runner exploded')),
    };
    const service = createInstallService({
      recipes: [getInstallRecipe('bun.update')],
      ...detection,
      repository: memory.repository,
      runner,
      resolveGuard: () => Promise.resolve(ALLOWED_GUARD),
      generateId: () => 'exploded-run',
      now: () => 1_700_000_002_000,
      platform: 'linux',
    });

    const started = await service.start(
      { recipeId: 'bun.update', input: NO_INPUT },
      REQUEST_CONTEXT
    );
    const events = await collectEvents(
      await service.getRunStream(started.runId, REQUEST_CONTEXT.userId)
    );

    expect(events.at(-1)).toMatchObject({ type: 'error', done: true });
    // `spawn-failed` would assert the installer never ran, which this failure
    // does not establish.
    expect(memory.runs.get('exploded-run')).toMatchObject({
      status: 'failed',
      exitCode: null,
      finishedAt: 1_700_000_002_000,
    });
  });

  it('reports the real outcome when the terminal audit write fails', async () => {
    const detection = createDetectionServices();
    const memory = createMemoryRepository();
    const repository: InstallRunRepository = {
      ...memory.repository,
      complete: () => Promise.reject(new Error('database is locked')),
    };
    const runner: InstallRunner = {
      run: () =>
        Promise.resolve({
          exitCode: 0,
          status: 'succeeded',
          truncated: false,
          finishedAt: 1_700_000_001_000,
          durationMs: 1000,
        }),
    };
    const service = createInstallService({
      recipes: [getInstallRecipe('bun.update')],
      ...detection,
      repository,
      runner,
      resolveGuard: () => Promise.resolve(ALLOWED_GUARD),
      generateId: () => 'unrecorded-run',
      now: () => 1_700_000_000_000,
      platform: 'linux',
    });

    const started = await service.start(
      { recipeId: 'bun.update', input: NO_INPUT },
      REQUEST_CONTEXT
    );
    const events = await collectEvents(
      await service.getRunStream(started.runId, REQUEST_CONTEXT.userId)
    );

    expect(events).toContainEqual({
      type: 'log',
      stream: 'system',
      line: 'Install audit row was not updated: database is locked',
      done: false,
    });
    expect(events.at(-1)).toMatchObject({ type: 'exit', code: 0, status: 'succeeded', done: true });
  });

  it('asks the guard about the machine the request named, and probes that one', async () => {
    const detection = createDetectionServices();
    const memory = createMemoryRepository();
    const scopes: string[] = [];
    const guardEnvironments: (string | undefined)[] = [];
    const service = createInstallService({
      recipes: [getInstallRecipe('bun.update')],
      probingService: {
        ...detection.probingService,
        getRuntimeStatus: (scope, id) => {
          scopes.push(scope.environmentId);
          return detection.probingService.getRuntimeStatus(scope, id);
        },
      },
      repository: memory.repository,
      resolveGuard: (context) => {
        guardEnvironments.push(context.environmentId);
        return Promise.resolve(
          context.environmentId === 'ubuntu'
            ? { allowed: false, reasons: ['environment-not-trusted' as const] }
            : ALLOWED_GUARD
        );
      },
      now: () => 1_700_000_000_000,
      platform: 'linux',
    });

    const [recipe] = await service.listRecipes({ ...REQUEST_CONTEXT, environmentId: 'ubuntu' });

    expect(guardEnvironments).toEqual(['ubuntu']);
    expect(recipe?.guard).toEqual({ allowed: false, reasons: ['environment-not-trusted'] });
    // Requirements are a property of the target machine, so they were asked of
    // it rather than of the hub.
    expect(scopes.length).toBeGreaterThan(0);
    expect(scopes.every((environmentId) => environmentId === 'ubuntu')).toBe(true);
  });

  it('refuses to start on an environment that was never trusted', async () => {
    const detection = createDetectionServices();
    const memory = createMemoryRepository();
    const service = createInstallService({
      recipes: [getInstallRecipe('bun.update')],
      ...detection,
      repository: memory.repository,
      resolveGuard: (context) =>
        Promise.resolve(
          context.environmentId === 'ubuntu'
            ? { allowed: false, reasons: ['environment-not-trusted' as const] }
            : ALLOWED_GUARD
        ),
      now: () => 1_700_000_000_000,
      platform: 'linux',
    });

    const attempt = service.start(
      { recipeId: 'bun.update', input: NO_INPUT, environmentId: 'ubuntu' },
      REQUEST_CONTEXT
    );

    await expect(attempt).rejects.toBeInstanceOf(InstallBlockedError);
    await expect(
      service.start({ recipeId: 'bun.update', input: NO_INPUT }, REQUEST_CONTEXT)
    ).resolves.toMatchObject({ attached: false });
  });
});
