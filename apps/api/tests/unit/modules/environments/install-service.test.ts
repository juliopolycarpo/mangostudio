import { describe, expect, it } from 'bun:test';

import type {
  AgentCliStatus,
  InstallGuard,
  InstallRun,
  RecipeInput,
  RuntimeStatus,
  ToolchainSelection,
  VersionManagerStatus,
} from '@mangostudio/shared/environments';
import { DEFAULT_TOOLCHAIN_SELECTION } from '@mangostudio/shared/environments';

import {
  createInstallService,
  InstallBlockedError,
  InstallPreparationError,
  InstallRuntimeBusyError,
} from '../../../../src/modules/environments/application/install-service';
import type { EnvironmentProbingService } from '../../../../src/modules/environments/application/probing-service';
import type { ToolchainService } from '../../../../src/modules/environments/application/toolchain-service';
import {
  getInstallRecipe,
  INSTALL_RECIPES,
  type InstallRecipe,
  type InstallRecipeProbe,
} from '../../../../src/modules/environments/domain/install-recipes';
import type { InstallRunRepository } from '../../../../src/modules/environments/infrastructure/install-run-repository';
import type { InstallRunner } from '../../../../src/modules/environments/infrastructure/install-runner';
import type {
  InstallerArtifact,
  InstallerDownloader,
} from '../../../../src/modules/environments/infrastructure/installer-download';
import { DiagnosticWarnCapture, expectHubLogEntry } from '../../../support/diagnostic-warn-capture';

/** Always answers the default selection; no run in this file exercises a stored override. */
class FakeToolchainService implements ToolchainService {
  listByUser(): Promise<Map<string, ToolchainSelection>> {
    throw new Error('Unexpected batch toolchain read during an individual install');
  }
  resolve(): Promise<ToolchainSelection> {
    return Promise.resolve(DEFAULT_TOOLCHAIN_SELECTION);
  }
  update(): Promise<ToolchainSelection> {
    return Promise.resolve(DEFAULT_TOOLCHAIN_SELECTION);
  }
}
const NO_OP_TOOLCHAIN = new FakeToolchainService();

const ALLOWED_GUARD: InstallGuard = { allowed: true, reasons: [] };
const BLOCKED_GUARD: InstallGuard = { allowed: false, reasons: ['disabled'] };
const REQUEST_CONTEXT = {
  userId: 'install-user',
  clientIp: '127.0.0.1',
} as const;
const NO_INPUT = { kind: 'none' } as const;
/** Raw probe failure text: a hub filesystem path and driver wording a client must not read. */
const PROBE_FAILURE_DETAIL = "ENOENT: no such file or directory, open '/home/alice/.nvm/nvm.sh'";
/** Raw database text for the audit-row failure. */
const AUDIT_FAILURE_DETAIL =
  'SQLITE_BUSY: database is locked (UPDATE "install_runs" SET "status" = ? WHERE "id" = ?)';
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
  const resetCacheCalls: string[] = [];
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
    resetCache: (environmentId) => {
      if (environmentId) resetCacheCalls.push(environmentId);
    },
    resetLocationCache: () => undefined,
  };
  return {
    probingService,
    getForcedRuntimeProbes: () => forcedRuntimeProbes,
    getResetCacheCalls: () => resetCacheCalls,
  };
}

/**
 * Every forced probe the service asked for, in order, flattened to the same
 * `{ kind, id }` shape a recipe's `probe` declaration reduces to. Lazy reads —
 * the ones `inspectRequirements` makes — are deliberately not recorded: only
 * the post-install refresh is what the declaration is about.
 */
interface ForcedProbe {
  readonly kind: InstallRecipeProbe['kind'];
  readonly id: string;
}

function declaredProbes(probe: readonly InstallRecipeProbe[]): ForcedProbe[] {
  return probe.map((target) => {
    if (target.kind === 'runtime') return { kind: target.kind, id: target.runtimeId };
    if (target.kind === 'version-manager')
      return { kind: target.kind, id: target.versionManagerId };
    return { kind: target.kind, id: target.targetId };
  });
}

/**
 * Answers every id as installed, so any recipe's requirements resolve and the
 * run reaches its post-install probe whatever it declares.
 */
function createRecordingProbingService() {
  const forced: ForcedProbe[] = [];
  const runtimeStatus = (id: RuntimeStatus['id']): RuntimeStatus => ({ ...BUN_STATUS, id });
  const probingService: EnvironmentProbingService = {
    listRuntimeStatuses: () => Promise.resolve([BUN_STATUS]),
    getRuntimeStatus: (_scope, id, options) => {
      if (options?.force) forced.push({ kind: 'runtime', id });
      return Promise.resolve(runtimeStatus(id));
    },
    listVersionManagerStatuses: () => Promise.resolve([]),
    getVersionManagerStatus: (_scope, id, options) => {
      if (options?.force) forced.push({ kind: 'version-manager', id });
      const status: VersionManagerStatus = {
        id,
        installed: true,
        root: '/home/tester/.nvm',
        versions: [],
        findings: [],
      };
      return Promise.resolve(status);
    },
    listAgentCliStatuses: () => Promise.resolve([]),
    getAgentCliStatus: (_scope, targetId, options) => {
      if (options?.force) forced.push({ kind: 'agent', id: targetId });
      const status: AgentCliStatus = {
        ...runtimeStatus(targetId),
        targetId,
        configHome: `/home/tester/.${targetId}`,
        configHomeExists: true,
        authenticated: false,
        authSignal: 'unknown',
        locations: [],
      };
      return Promise.resolve(status);
    },
    listLocationStatuses: () => Promise.resolve([]),
    resetCache: () => undefined,
    resetLocationCache: () => undefined,
  };
  return { probingService, forced };
}

function succeedingRunner(): InstallRunner {
  return {
    run: () =>
      Promise.resolve({
        exitCode: 0,
        status: 'succeeded',
        truncated: false,
        finishedAt: 1_700_000_001_000,
        durationMs: 1000,
      }),
  };
}

function stubDownloader(): InstallerDownloader {
  return {
    download: () =>
      Promise.resolve({
        path: '/tmp/installer/installer.sh',
        url: 'https://example.test/install.sh',
        sizeBytes: 512,
        sha256: 'b'.repeat(64),
        cleanup: () => Promise.resolve(),
      }),
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
      toolchain: NO_OP_TOOLCHAIN,
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
    expect(detection.getResetCacheCalls()).toEqual(['local']);
    expect(detection.getForcedRuntimeProbes()).toBe(1);
    expect(memory.runs.get(started.runId)?.status).toBe('succeeded');
  });

  // Table-driven over the registry itself so a ninth recipe joins without
  // anyone remembering to extend this file — which is the failure #699 is about.
  for (const recipe of INSTALL_RECIPES) {
    // A copy-only recipe has no automated run at all: `start` always refuses
    // it, so what this table asserts for it is the refusal, not a probe.
    if (!recipe.argv) {
      it(`refuses to start ${recipe.id}, which has no automated run`, async () => {
        const detection = createRecordingProbingService();
        const memory = createMemoryRepository();
        const service = createInstallService({
          recipes: [recipe],
          probingService: detection.probingService,
          repository: memory.repository,
          runner: succeedingRunner(),
          resolveGuard: () => Promise.resolve(ALLOWED_GUARD),
          now: () => 1_700_000_000_000,
          platform: recipe.platforms[0],
        });

        const input: RecipeInput =
          recipe.inputKind === 'node-version' ? { kind: 'node-version', version: 'lts' } : NO_INPUT;

        await expect(
          service.start({ recipeId: recipe.id, input }, REQUEST_CONTEXT)
        ).rejects.toThrow('has no automated run');
        expect(detection.forced).toEqual([]);
      });
      continue;
    }

    it(`re-probes exactly what ${recipe.id} declares`, async () => {
      const detection = createRecordingProbingService();
      const memory = createMemoryRepository();
      let nextId = 0;
      const service = createInstallService({
        toolchain: NO_OP_TOOLCHAIN,
        recipes: [recipe],
        probingService: detection.probingService,
        repository: memory.repository,
        runner: succeedingRunner(),
        downloader: stubDownloader(),
        resolveGuard: () => Promise.resolve(ALLOWED_GUARD),
        generateId: () => {
          nextId += 1;
          return `${recipe.id}-${nextId}`;
        },
        now: () => 1_700_000_000_000,
        platform: recipe.platforms[0],
      });

      const input: RecipeInput =
        recipe.inputKind === 'node-version' ? { kind: 'node-version', version: 'lts' } : NO_INPUT;
      const body = { recipeId: recipe.id, input } as const;
      // A downloaded installer may only run from a preparation the caller holds.
      const preparation = recipe.download ? await service.prepare(body, REQUEST_CONTEXT) : null;
      const started = await service.start(
        {
          ...body,
          ...(preparation?.preparationId && { preparationId: preparation.preparationId }),
        },
        REQUEST_CONTEXT
      );
      const events = await collectEvents(
        await service.getRunStream(started.runId, REQUEST_CONTEXT.userId)
      );

      const expected = declaredProbes(recipe.probe);
      expect(detection.forced).toEqual(expected);
      expect(events.filter((event) => event.type === 'probe').map((event) => event.target)).toEqual(
        expected.map((target) => target.kind)
      );
    });
  }

  it('dispatches on the declaration rather than the recipe id', async () => {
    // `bun` is neither an agent id nor a version manager, so the id-branching
    // this replaced could only ever have re-probed the runtime here. Both
    // surfaces refreshing is the proof that the declaration is what is read.
    const detection = createRecordingProbingService();
    const memory = createMemoryRepository();
    const recipe: InstallRecipe = {
      ...getInstallRecipe('bun.update'),
      probe: [
        { kind: 'agent', targetId: 'claude' },
        { kind: 'version-manager', versionManagerId: 'nvm' },
      ],
    };
    const service = createInstallService({
      toolchain: NO_OP_TOOLCHAIN,
      recipes: [recipe],
      probingService: detection.probingService,
      repository: memory.repository,
      runner: succeedingRunner(),
      resolveGuard: () => Promise.resolve(ALLOWED_GUARD),
      generateId: () => 'declared-run',
      now: () => 1_700_000_000_000,
      platform: 'linux',
    });

    const started = await service.start(
      { recipeId: 'bun.update', input: NO_INPUT },
      REQUEST_CONTEXT
    );
    await collectEvents(await service.getRunStream(started.runId, REQUEST_CONTEXT.userId));

    expect(detection.forced).toEqual([
      { kind: 'agent', id: 'claude' },
      { kind: 'version-manager', id: 'nvm' },
    ]);
  });

  it('continues later declared probes when one forced probe rejects', async () => {
    const detection = createRecordingProbingService();
    const originalGetRuntimeStatus = detection.probingService.getRuntimeStatus;
    detection.probingService.getRuntimeStatus = (_scope, id, options) => {
      if (options?.force) {
        detection.forced.push({ kind: 'runtime', id });
        return Promise.reject(new Error(PROBE_FAILURE_DETAIL));
      }
      return originalGetRuntimeStatus(_scope, id, options);
    };
    const recipe = getInstallRecipe('nvm.node.install');
    const memory = createMemoryRepository();
    const service = createInstallService({
      toolchain: NO_OP_TOOLCHAIN,
      recipes: [recipe],
      probingService: detection.probingService,
      repository: memory.repository,
      runner: succeedingRunner(),
      resolveGuard: () => Promise.resolve(ALLOWED_GUARD),
      generateId: () => 'partial-probe-run',
      now: () => 1_700_000_000_000,
      platform: 'linux',
    });

    let events: Record<string, unknown>[] = [];
    const logged = await new DiagnosticWarnCapture().during(async () => {
      const started = await service.start(
        { recipeId: recipe.id, input: { kind: 'node-version', version: 'lts' } },
        REQUEST_CONTEXT
      );
      events = await collectEvents(
        await service.getRunStream(started.runId, REQUEST_CONTEXT.userId)
      );
    });

    expect(detection.forced).toEqual([
      { kind: 'runtime', id: 'node' },
      { kind: 'version-manager', id: 'nvm' },
    ]);
    expect(events).toContainEqual({
      type: 'log',
      stream: 'system',
      line: 'Post-install probe failed. Details are in the hub log.',
      done: false,
    });
    // Guard, not a regression test: #2339 already fixed the line. The log entry
    // below is what #2340 adds coverage for.
    expect(
      JSON.stringify(events).includes('/home/alice'),
      `(probe): expected a stream without the hub path | received: ${JSON.stringify(events)}`
    ).toBe(false);
    expectHubLogEntry(logged, 'post_install_probe_failed', {
      fields: { environmentId: 'local' },
      fragment: PROBE_FAILURE_DETAIL,
    });
    expect(events.filter((event) => event.type === 'probe').map((event) => event.target)).toEqual([
      'version-manager',
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'exit', status: 'succeeded', done: true });
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
      toolchain: NO_OP_TOOLCHAIN,
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
      toolchain: NO_OP_TOOLCHAIN,
      recipes: [getInstallRecipe('bun.update')],
      ...detection,
      repository: memory.repository,
      resolveGuard: () => Promise.resolve(BLOCKED_GUARD),
      platform: 'linux',
    });

    const [preview] = await service.listRecipes(REQUEST_CONTEXT);

    expect(preview?.guard).toEqual(BLOCKED_GUARD);
    // The runner spawns the resolved absolute path — a service-launched
    // runtime's own PATH is exactly what this sidesteps — while the copy
    // command still shows the plain name for the user's own shell.
    expect(preview?.argv).toEqual(['/home/tester/.bun/bin/bun', 'upgrade']);
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
      toolchain: NO_OP_TOOLCHAIN,
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

  // Regression: `profileLines` are POSIX `export` lines, so inspecting a
  // Windows target's shell profiles for them reported a setup step that has no
  // meaning there — and disclosed bash syntax beside a PowerShell installer.
  it('never inspects shell profiles on a win32 target', async () => {
    const detection = createDetectionServices();
    const memory = createMemoryRepository();
    let inspected = 0;
    const service = createInstallService({
      toolchain: NO_OP_TOOLCHAIN,
      recipes: [getInstallRecipe('bun.install.official')],
      ...detection,
      repository: memory.repository,
      resolveGuard: () => Promise.resolve(ALLOWED_GUARD),
      inspectProfileSetup: (lines) => {
        inspected += 1;
        return Promise.resolve({ lines: [...lines], present: false, detectedIn: [] });
      },
      platform: 'win32',
    });

    const [preview] = await service.listRecipes(REQUEST_CONTEXT);

    expect(inspected).toBe(0);
    expect(preview?.profileSetup).toBeUndefined();
  });

  // Regression: `writes` is one flat cross-platform list, and the uninstall
  // confirmation reads it back verbatim as "this removes …".
  it('discloses only this platform’s spelling of the paths a recipe writes', async () => {
    const detection = createDetectionServices();
    const memory = createMemoryRepository();
    const service = createInstallService({
      toolchain: NO_OP_TOOLCHAIN,
      recipes: [getInstallRecipe('claude.uninstall')],
      ...detection,
      repository: memory.repository,
      resolveGuard: () => Promise.resolve(ALLOWED_GUARD),
      platform: 'linux',
    });

    const [preview] = await service.listRecipes(REQUEST_CONTEXT);

    expect(preview?.writes).toEqual(['$HOME/.local/bin/claude', '$HOME/.local/share/claude']);
  });

  it("reports nvm.install's pinned digest before anything has been downloaded", async () => {
    const detection = createDetectionServices();
    const memory = createMemoryRepository();
    const service = createInstallService({
      recipes: [getInstallRecipe('nvm.install')],
      ...detection,
      repository: memory.repository,
      resolveGuard: () => Promise.resolve(ALLOWED_GUARD),
      platform: 'linux',
    });

    const [preview] = await service.listRecipes(REQUEST_CONTEXT);

    expect(preview?.download).toMatchObject({
      url: 'https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.7/install.sh',
      pinnedSha256: '066ce4eaf4d78eaa6410433bc9ba58faaba646157cbbed6109153e6c24c5f8a5',
    });
    // Not fetched yet — no verified digest of the actual bytes exists.
    expect(preview?.download?.sha256).toBeUndefined();
  });

  it('offers a copy-only recipe with an empty argv and runnable: false', async () => {
    const detection = createDetectionServices();
    const memory = createMemoryRepository();
    const service = createInstallService({
      recipes: [getInstallRecipe('cursor.uninstall')],
      ...detection,
      repository: memory.repository,
      resolveGuard: () => Promise.resolve(ALLOWED_GUARD),
      platform: 'linux',
    });

    const [preview] = await service.listRecipes(REQUEST_CONTEXT);

    expect(preview?.runnable).toBe(false);
    expect(preview?.unrunnableReason).toBe('vendor-undocumented');
    expect(preview?.argv).toEqual([]);
    expect(preview?.copyCommand).toBe('rm -rf ~/.local/bin/agent ~/.cursor');
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
      toolchain: NO_OP_TOOLCHAIN,
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
      toolchain: NO_OP_TOOLCHAIN,
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
      toolchain: NO_OP_TOOLCHAIN,
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
      toolchain: NO_OP_TOOLCHAIN,
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
      toolchain: NO_OP_TOOLCHAIN,
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
    // Regression: the thrown error's own text used to be the event's message.
    expect(JSON.stringify(events.at(-1))).not.toContain('runner exploded');
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
      complete: () => Promise.reject(new Error(AUDIT_FAILURE_DETAIL)),
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
      toolchain: NO_OP_TOOLCHAIN,
      recipes: [getInstallRecipe('bun.update')],
      ...detection,
      repository,
      runner,
      resolveGuard: () => Promise.resolve(ALLOWED_GUARD),
      generateId: () => 'unrecorded-run',
      now: () => 1_700_000_000_000,
      platform: 'linux',
    });

    let events: Record<string, unknown>[] = [];
    const logged = await new DiagnosticWarnCapture().during(async () => {
      const started = await service.start(
        { recipeId: 'bun.update', input: NO_INPUT },
        REQUEST_CONTEXT
      );
      events = await collectEvents(
        await service.getRunStream(started.runId, REQUEST_CONTEXT.userId)
      );
    });

    expect(events).toContainEqual({
      type: 'log',
      stream: 'system',
      line: 'Install audit row was not updated. Details are in the hub log.',
      done: false,
    });
    // Guard, not a regression test: #2339 already fixed the line. The log entry
    // below, now with the environment id, is what #2340 adds.
    expect(
      JSON.stringify(events).includes('SQLITE_BUSY'),
      `(audit row): expected a stream without the SQL error | received: ${JSON.stringify(events)}`
    ).toBe(false);
    expectHubLogEntry(logged, 'install_audit_row_not_updated', {
      fields: { runId: 'unrecorded-run', environmentId: 'local' },
      fragment: AUDIT_FAILURE_DETAIL,
    });
    expect(events.at(-1)).toMatchObject({ type: 'exit', code: 0, status: 'succeeded', done: true });
  });

  it('asks the guard about the machine the request named, and probes that one', async () => {
    const detection = createDetectionServices();
    const memory = createMemoryRepository();
    const scopes: string[] = [];
    const guardEnvironments: (string | undefined)[] = [];
    const service = createInstallService({
      toolchain: NO_OP_TOOLCHAIN,
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

  describe('per-runtime exclusion', () => {
    function createBunService(controlled: ReturnType<typeof deferredRunner>) {
      let nextId = 0;
      return createInstallService({
        toolchain: NO_OP_TOOLCHAIN,
        recipes: [getInstallRecipe('bun.update'), getInstallRecipe('bun.uninstall')],
        ...createDetectionServices(),
        repository: createMemoryRepository().repository,
        runner: controlled.runner,
        resolveGuard: () => Promise.resolve(ALLOWED_GUARD),
        generateId: () => {
          nextId += 1;
          return `exclusion-run-${nextId}`;
        },
        now: () => 1_700_000_000_000,
        platform: 'linux',
      });
    }
    const UPDATE = { recipeId: 'bun.update', input: NO_INPUT } as const;
    const UNINSTALL = { recipeId: 'bun.uninstall', input: NO_INPUT } as const;

    it('refuses an uninstall while an update of the same runtime runs, naming the update', async () => {
      const controlled = deferredRunner();
      const service = createBunService(controlled);
      const update = await service.start(UPDATE, REQUEST_CONTEXT);

      const attempt = service.start(UNINSTALL, REQUEST_CONTEXT);

      await expect(attempt).rejects.toMatchObject({
        name: 'InstallRuntimeBusyError',
        runtimeId: 'bun',
        requestedRecipeId: 'bun.uninstall',
        runningRecipeId: 'bun.update',
        runningRunId: update.runId,
      });
      controlled.finish();
    });

    it('lets exactly one of two conflicting starts through when they overlap', async () => {
      const controlled = deferredRunner();
      const service = createBunService(controlled);

      // Neither has registered a run yet; which preview settles first is not
      // part of the contract, only that the pair never both proceeds.
      const outcomes = await Promise.allSettled([
        service.start(UPDATE, REQUEST_CONTEXT),
        service.start(UNINSTALL, REQUEST_CONTEXT),
      ]);

      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
      const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
      expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(
        InstallRuntimeBusyError
      );
      controlled.finish();
    });

    it('lets the other recipe run once the first one has finished', async () => {
      const controlled = deferredRunner();
      const service = createBunService(controlled);
      const update = await service.start(UPDATE, REQUEST_CONTEXT);
      const events = collectEvents(
        await service.getRunStream(update.runId, REQUEST_CONTEXT.userId)
      );
      controlled.finish();
      await events;

      await expect(service.start(UNINSTALL, REQUEST_CONTEXT)).resolves.toMatchObject({
        attached: false,
      });
    });

    it('does not cross machines', async () => {
      const controlled = deferredRunner();
      const service = createBunService(controlled);
      await service.start(UPDATE, REQUEST_CONTEXT);

      await expect(
        service.start({ ...UNINSTALL, environmentId: 'ubuntu' }, REQUEST_CONTEXT)
      ).resolves.toMatchObject({ attached: false });
      controlled.finish();
    });
  });

  it('refuses to start on an environment that was never trusted', async () => {
    const detection = createDetectionServices();
    const memory = createMemoryRepository();
    const service = createInstallService({
      toolchain: NO_OP_TOOLCHAIN,
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
