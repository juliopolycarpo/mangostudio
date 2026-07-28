import { afterEach, describe, expect, it } from 'bun:test';
import { DEFAULT_PROFILE_ID } from '@mangostudio/shared/profiles';
import { getDb } from '../../../../src/db/database';
import { createInstallRunRepository } from '../../../../src/modules/environments/infrastructure/install-run-repository';
import { insertTestUser } from '../../../support/factories';

const userIds: string[] = [];

afterEach(async () => {
  if (userIds.length === 0) return;
  await getDb().deleteFrom('user').where('id', 'in', userIds.splice(0)).execute();
});

describe('install run repository', () => {
  it('persists, completes, scopes, and lists an install audit record', async () => {
    const user = await insertTestUser();
    const otherUser = await insertTestUser();
    userIds.push(user.id, otherUser.id);
    const repository = createInstallRunRepository();

    const created = await repository.create({
      id: 'install-run-1',
      userId: user.id,
      profileId: DEFAULT_PROFILE_ID,
      recipeId: 'bun.update',
      argv: ['bun', 'upgrade'],
      startedAt: 1_700_000_000_000,
    });

    expect(created).toEqual({
      id: 'install-run-1',
      recipeId: 'bun.update',
      argv: ['bun', 'upgrade'],
      startedAt: 1_700_000_000_000,
      finishedAt: null,
      exitCode: null,
      status: 'running',
      truncated: false,
    });
    expect(await repository.find(created.id, otherUser.id, DEFAULT_PROFILE_ID)).toBeNull();

    await repository.complete(created.id, user.id, DEFAULT_PROFILE_ID, {
      finishedAt: 1_700_000_001_000,
      exitCode: 0,
      status: 'succeeded',
      truncated: true,
    });

    expect(await repository.find(created.id, user.id, DEFAULT_PROFILE_ID)).toEqual({
      ...created,
      finishedAt: 1_700_000_001_000,
      exitCode: 0,
      status: 'succeeded',
      truncated: true,
    });
    expect(await repository.list(user.id, DEFAULT_PROFILE_ID)).toHaveLength(1);
  });
});
