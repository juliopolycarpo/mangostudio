import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  InstallGuard,
  InstallStreamEvent,
  RuntimeStatus,
} from '@mangostudio/shared/environments';
import { DEFAULT_PROFILE_ID } from '@mangostudio/shared/profiles';
import { getDb } from '../../../src/db/database';
import { createInstallService } from '../../../src/modules/environments/application/install-service';
import type { EnvironmentProbingService } from '../../../src/modules/environments/application/probing-service';
import type { InstallRecipe } from '../../../src/modules/environments/domain/install-recipes';
import { createInstallRunRepository } from '../../../src/modules/environments/infrastructure/install-run-repository';
import {
  createInstallRunner,
  type InstallRunner,
  installRunner,
} from '../../../src/modules/environments/infrastructure/install-runner';
import { insertTestUser } from '../../support/factories';
import { resolveRustRuntimeBinary, skipWithoutRustBinary } from '../../support/rust-runtime-binary';
import { type RustStdioRuntime, spawnRustStdioRuntime } from '../../support/rust-stdio-runtime';

const ALLOWED_GUARD: InstallGuard = { allowed: true, reasons: [] };
const BUN_STATUS: RuntimeStatus = {
  id: 'bun',
  health: 'ok',
  installations: [
    {
      path: '/usr/bin/bun',
      rawPath: '/usr/bin/bun',
      version: '1.3.0',
      origin: 'path',
      pathIndex: 0,
      effective: true,
    },
  ],
  findings: [],
  installable: true,
  probedAtMs: 1_700_000_000_000,
};

const tempDirs: string[] = [];
const userIds: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  if (userIds.length > 0) {
    await getDb().deleteFrom('user').where('id', 'in', userIds.splice(0)).execute();
  }
});

function directRecipe(argv: readonly string[]): InstallRecipe {
  return {
    id: 'bun.update',
    runtimeId: 'bun',
    action: 'update',
    inputKind: 'none',
    platforms: ['linux'],
    requires: [],
    writes: ['$BUN_INSTALL/bin/bun'],
    networkAccess: false,
    timeoutMs: 5000,
    probe: [{ kind: 'runtime', runtimeId: 'bun' }],
    argv: () => argv,
    copyCommand: () => argv.join(' '),
  };
}

function detectionServices() {
  const probingService: EnvironmentProbingService = {
    listRuntimeStatuses: () => Promise.resolve([BUN_STATUS]),
    getRuntimeStatus: (_scope, id) => Promise.resolve(id === 'bun' ? BUN_STATUS : null),
    listVersionManagerStatuses: () => Promise.resolve([]),
    getVersionManagerStatus: () => Promise.resolve(null),
    listAgentCliStatuses: () => Promise.resolve([]),
    getAgentCliStatus: () => Promise.resolve(null),
    listLocationStatuses: () => Promise.resolve([]),
    resetCache: () => undefined,
    resetLocationCache: () => undefined,
  };
  return { probingService };
}

async function execute(argv: readonly string[], runner: InstallRunner = installRunner) {
  const user = await insertTestUser();
  userIds.push(user.id);
  const logDir = await mkdtemp(join(tmpdir(), 'mangostudio-install-test-'));
  tempDirs.push(logDir);
  const repository = createInstallRunRepository();
  let nextId = 0;
  const service = createInstallService({
    recipes: [directRecipe(argv)],
    ...detectionServices(),
    repository,
    runner,
    resolveGuard: () => Promise.resolve(ALLOWED_GUARD),
    generateId: () => {
      nextId += 1;
      return `execution-${nextId}`;
    },
    now: Date.now,
    platform: 'linux',
    getLogPath: (runId) => join(logDir, `${runId}.log`),
    readLog: (path) => readFile(path, 'utf8'),
  });
  const started = await service.start(
    { recipeId: 'bun.update', input: { kind: 'none' } },
    { userId: user.id, clientIp: '127.0.0.1' }
  );
  const source = await service.getRunStream(started.runId, user.id);
  if (!source) throw new Error('Expected an install event stream.');
  const events: InstallStreamEvent[] = [];
  for await (const event of source) events.push(event);
  return {
    events,
    run: await repository.find(started.runId, user.id, DEFAULT_PROFILE_ID),
  };
}

function terminalStatus(events: readonly InstallStreamEvent[]) {
  return events.find(
    (event): event is Extract<InstallStreamEvent, { type: 'exit' }> => event.type === 'exit'
  )?.status;
}

/** The success case's own assertions, shared by the production Local run and the fresh stdio run. */
function expectStreamedSuccess(result: Awaited<ReturnType<typeof execute>>) {
  expect(result.events).toContainEqual({
    type: 'log',
    stream: 'stdout',
    line: 'hello',
    done: false,
  });
  expect(result.events.some((event) => event.type === 'probe')).toBe(true);
  expect(terminalStatus(result.events)).toBe('succeeded');
  expect(result.run?.status).toBe('succeeded');
  expect(result.run?.exitCode).toBe(0);
}

describe('environment install execution', () => {
  it('streams a direct command, emits a probe, and persists success', async () => {
    expectStreamedSuccess(await execute(['printf', 'hello\n']));
  });

  it('streams a non-zero exit and persists the failed audit result', async () => {
    const result = await execute(['false']);

    expect(terminalStatus(result.events)).toBe('failed');
    expect(result.run?.status).toBe('failed');
    expect(result.run?.exitCode).not.toBe(0);
  });
});

const binary = resolveRustRuntimeBinary();

describe('environment install execution over a real Rust runtime', () => {
  let runtime: RustStdioRuntime | undefined;

  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
  });

  // A fresh stdio connection per run, the shape that lost the output: the
  // runner unsubscribes from install.output the moment `install.run`
  // answers, so every line has to arrive ahead of that answer. Bun itself
  // prints the line, so the command exists on every OS the job runs on.
  it.skipIf(skipWithoutRustBinary(binary, 'environment-install-execution'))(
    'streams a direct command, emits a probe, and persists success',
    async () => {
      runtime = await spawnRustStdioRuntime(binary.path, { label: 'environment-install' });
      const client = runtime.client;
      const runner = createInstallRunner({ resolveClient: () => Promise.resolve(client) });

      expectStreamedSuccess(
        await execute([process.execPath, '-e', 'process.stdout.write("hello\\n")'], runner)
      );
    },
    30_000
  );
});
