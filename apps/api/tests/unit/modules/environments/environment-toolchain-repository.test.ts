import { afterEach, describe, expect, it } from 'bun:test';
import { getDb } from '../../../../src/db/database';
import { createEnvironmentToolchainRepository } from '../../../../src/modules/environments/infrastructure/environment-toolchain-repository';

const keys: Array<{ userId: string; environmentId: string }> = [];

afterEach(async () => {
  if (keys.length === 0) return;
  const db = getDb();
  for (const key of keys.splice(0)) {
    await db
      .deleteFrom('environment_toolchains')
      .where('userId', '=', key.userId)
      .where('environmentId', '=', key.environmentId)
      .execute();
  }
});

describe('environment toolchain repository', () => {
  it('reads null before any row is stored', async () => {
    const repository = createEnvironmentToolchainRepository();
    keys.push({ userId: 'toolchain-repo-user-1', environmentId: 'dev-box' });

    expect(await repository.get('toolchain-repo-user-1', 'dev-box')).toBeNull();
  });

  it('upserts a selection and reads it back', async () => {
    const repository = createEnvironmentToolchainRepository();
    keys.push({ userId: 'toolchain-repo-user-2', environmentId: 'dev-box' });

    await repository.upsert(
      'toolchain-repo-user-2',
      'dev-box',
      { node: '/opt/node/bin/node', bun: 'auto' },
      1_700_000_000_000
    );

    expect(await repository.get('toolchain-repo-user-2', 'dev-box')).toEqual({
      node: '/opt/node/bin/node',
      bun: 'auto',
    });
  });

  it('overwrites a previously stored selection for the same key', async () => {
    const repository = createEnvironmentToolchainRepository();
    keys.push({ userId: 'toolchain-repo-user-3', environmentId: 'dev-box' });

    await repository.upsert(
      'toolchain-repo-user-3',
      'dev-box',
      { node: 'auto', bun: 'auto' },
      1_700_000_000_000
    );
    await repository.upsert(
      'toolchain-repo-user-3',
      'dev-box',
      { node: '/opt/node/bin/node', bun: '/opt/bun/bin/bun' },
      1_700_000_001_000
    );

    expect(await repository.get('toolchain-repo-user-3', 'dev-box')).toEqual({
      node: '/opt/node/bin/node',
      bun: '/opt/bun/bin/bun',
    });
  });

  it('scopes a stored selection to its own (userId, environmentId) pair', async () => {
    const repository = createEnvironmentToolchainRepository();
    keys.push(
      { userId: 'toolchain-repo-user-4', environmentId: 'dev-box' },
      { userId: 'toolchain-repo-user-4', environmentId: 'cache-box' },
      { userId: 'toolchain-repo-user-5', environmentId: 'dev-box' }
    );

    await repository.upsert(
      'toolchain-repo-user-4',
      'dev-box',
      { node: '/opt/node/bin/node', bun: 'auto' },
      1_700_000_000_000
    );

    expect(await repository.get('toolchain-repo-user-4', 'cache-box')).toBeNull();
    expect(await repository.get('toolchain-repo-user-5', 'dev-box')).toBeNull();
  });

  it('accepts the local sentinel environment id with no foreign key to environments', async () => {
    const repository = createEnvironmentToolchainRepository();
    keys.push({ userId: 'toolchain-repo-user-6', environmentId: 'local' });

    await repository.upsert(
      'toolchain-repo-user-6',
      'local',
      { node: 'auto', bun: '/opt/bun/bin/bun' },
      1_700_000_000_000
    );

    expect(await repository.get('toolchain-repo-user-6', 'local')).toEqual({
      node: 'auto',
      bun: '/opt/bun/bin/bun',
    });
  });

  it('removes a stored selection', async () => {
    const repository = createEnvironmentToolchainRepository();
    keys.push({ userId: 'toolchain-repo-user-7', environmentId: 'dev-box' });

    await repository.upsert(
      'toolchain-repo-user-7',
      'dev-box',
      { node: '/opt/node/bin/node', bun: 'auto' },
      1_700_000_000_000
    );
    await repository.remove('toolchain-repo-user-7', 'dev-box');

    expect(await repository.get('toolchain-repo-user-7', 'dev-box')).toBeNull();
  });

  it('removing an unstored selection is a no-op', async () => {
    const repository = createEnvironmentToolchainRepository();

    await expect(repository.remove('toolchain-repo-user-8', 'dev-box')).resolves.toBeUndefined();
  });
});
