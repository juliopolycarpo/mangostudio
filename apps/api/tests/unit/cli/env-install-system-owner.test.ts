/**
 * `env install` on a hub nobody has signed in to: the run is recorded under the
 * reserved system owner (migration 071) instead of failing the audit table's
 * foreign key, and that owner is never mistaken for an account.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import type {
  RuntimeStatus,
  ToolchainSelection,
  VersionManagerStatus,
} from '@mangostudio/shared/environments';
import { DEFAULT_TOOLCHAIN_SELECTION } from '@mangostudio/shared/environments';

import type { EnvArgs } from '../../../src/cli/args';
import { resolveCliUserId, runEnvInstall } from '../../../src/cli/commands/env';
import { CliError } from '../../../src/cli/errors';
import { getDb } from '../../../src/db/database';
import { SYSTEM_OWNER_EMAIL, SYSTEM_OWNER_USER_ID } from '../../../src/db/system-owner';
import {
  createInstallService,
  type InstallService,
} from '../../../src/modules/environments/application/install-service';
import type { EnvironmentProbingService } from '../../../src/modules/environments/application/probing-service';
import type { ToolchainService } from '../../../src/modules/environments/application/toolchain-service';
import { getInstallRecipe } from '../../../src/modules/environments/domain/install-recipes';
import type { InstallRunner } from '../../../src/modules/environments/infrastructure/install-runner';
import { insertTestUser } from '../../support/factories';

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

/** Answers Bun as installed and everything else as absent; nothing here touches a machine. */
class FakeBunProbingService implements EnvironmentProbingService {
  listRuntimeStatuses = () => Promise.resolve([BUN_STATUS]);
  getRuntimeStatus: EnvironmentProbingService['getRuntimeStatus'] = (_scope, id) =>
    Promise.resolve(id === 'bun' ? BUN_STATUS : null);
  listVersionManagerStatuses = () => Promise.resolve([] as VersionManagerStatus[]);
  getVersionManagerStatus = () => Promise.resolve(null);
  listAgentCliStatuses = () => Promise.resolve([]);
  getAgentCliStatus = () => Promise.resolve(null);
  listLocationStatuses = () => Promise.resolve([]);
  resetCache = () => undefined;
  resetLocationCache = () => undefined;
}

class FakeDefaultToolchainService implements ToolchainService {
  listByUser(): Promise<Map<string, ToolchainSelection>> {
    return Promise.resolve(new Map());
  }
  resolve(): Promise<ToolchainSelection> {
    return Promise.resolve(DEFAULT_TOOLCHAIN_SELECTION);
  }
  update(): Promise<ToolchainSelection> {
    return Promise.resolve(DEFAULT_TOOLCHAIN_SELECTION);
  }
}

const succeedingRunner: InstallRunner = {
  run: () =>
    Promise.resolve({
      exitCode: 0,
      status: 'succeeded',
      truncated: false,
      finishedAt: 1_700_000_001_000,
      durationMs: 10,
    }),
};

/** The real repository and database, with only the machine-facing edges faked. */
function createServiceOverRealDatabase(): InstallService {
  return createInstallService({
    toolchain: new FakeDefaultToolchainService(),
    recipes: [getInstallRecipe('bun.update')],
    probingService: new FakeBunProbingService(),
    runner: succeedingRunner,
    resolveGuard: () => Promise.resolve({ allowed: true, reasons: [] }),
    platform: 'linux',
  });
}

const createdUserIds: string[] = [];

afterEach(async () => {
  await getDb().deleteFrom('environment_install_runs').execute();
  if (createdUserIds.length > 0) {
    await getDb().deleteFrom('user').where('id', 'in', createdUserIds.splice(0)).execute();
  }
});

describe('env install without an account', () => {
  it('succeeds and records the run under the reserved system owner', async () => {
    const lines: string[] = [];

    const code = await runEnvInstall(
      { subcommand: 'update', recipeId: 'bun.update', json: false } as EnvArgs,
      { service: createServiceOverRealDatabase(), log: (line) => lines.push(line) }
    );

    expect(code, `env update bun.update exit code; output: ${lines.join(' | ')}`).toBe(0);
    const rows = await getDb()
      .selectFrom('environment_install_runs')
      .select(['userId', 'recipeId', 'status'])
      .execute();
    expect(rows).toEqual([
      { userId: SYSTEM_OWNER_USER_ID, recipeId: 'bun.update', status: 'succeeded' },
    ]);
  });
});

describe('resolveCliUserId', () => {
  it('falls back to the system owner when only the system owner exists', async () => {
    await expect(resolveCliUserId(undefined, { fallback: SYSTEM_OWNER_USER_ID })).resolves.toBe(
      SYSTEM_OWNER_USER_ID
    );
  });

  it('picks the one real account instead of reporting two accounts', async () => {
    const user = await insertTestUser();
    createdUserIds.push(user.id);

    await expect(resolveCliUserId(undefined, { fallback: SYSTEM_OWNER_USER_ID })).resolves.toBe(
      user.id
    );
  });

  it('asks for an account when a command needs a real one and none exists', async () => {
    await expect(resolveCliUserId(undefined)).rejects.toThrow(
      new CliError('No account exists yet. Sign in once in the browser first.')
    );
  });

  it('does not accept the system owner by email as an account to act for', async () => {
    await expect(resolveCliUserId(SYSTEM_OWNER_EMAIL)).rejects.toThrow(
      `No account with email ${SYSTEM_OWNER_EMAIL}.`
    );
  });
});
