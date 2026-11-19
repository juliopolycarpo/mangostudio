import { afterEach, describe, expect, it } from 'bun:test';

import { RemoteError } from '@mangostudio/protocol';

import { resolveDirectorySpellings } from '../../../../src/modules/git/infrastructure/runtime-directories';
import {
  type FakeWorkspaceRuntime,
  installFakeWorkspaceRuntime,
} from '../../../support/fake-workspace-runtime';

const selection = { userId: 'user-1', environmentId: 'devbox' };
let runtime: FakeWorkspaceRuntime | undefined;

afterEach(() => {
  runtime?.restore();
  runtime = undefined;
});

describe('resolveDirectorySpellings', () => {
  it('adds the runtime canonical form of a directory that resolves elsewhere', async () => {
    runtime = installFakeWorkspaceRuntime({ '/tmp/x/feature': '/private/tmp/x/feature' });

    const resolved = await resolveDirectorySpellings(['/tmp/x/feature'], selection);

    expect(resolved.get('/tmp/x/feature')).toEqual(['/tmp/x/feature', '/private/tmp/x/feature']);
  });

  it('answers a directory that does not exist with the spelling it was given', async () => {
    runtime = installFakeWorkspaceRuntime({});

    const resolved = await resolveDirectorySpellings(['/work/missing'], selection);

    expect(resolved.get('/work/missing')).toEqual(['/work/missing']);
  });

  it('asks once per distinct path, however often it is repeated', async () => {
    runtime = installFakeWorkspaceRuntime({ '/work/a': '/work/a', '/work/b': '/real/b' });

    const resolved = await resolveDirectorySpellings(
      ['/work/a', '/work/b', '/work/a', '/work/b'],
      selection
    );

    expect([...runtime.validated].sort()).toEqual(['/work/a', '/work/b']);
    expect(resolved.size).toBe(2);
  });

  it('makes no runtime request for an empty list', async () => {
    runtime = installFakeWorkspaceRuntime({});

    expect((await resolveDirectorySpellings([], selection)).size).toBe(0);
    expect(runtime.validated).toEqual([]);
  });

  it('treats a path the runtime rejects as unresolved rather than failing the list', async () => {
    runtime = installFakeWorkspaceRuntime({
      '/work/odd': new RemoteError('INVALID_PARAMS', 'bad path', { kind: 'workdir_validation' }),
    });

    const resolved = await resolveDirectorySpellings(['/work/odd'], selection);

    expect(resolved.get('/work/odd')).toEqual(['/work/odd']);
  });

  it('lets a transport failure through instead of guessing the directory is unresolved', async () => {
    runtime = installFakeWorkspaceRuntime({
      '/work/a': new RemoteError('INTERNAL', 'connection lost'),
    });

    const failure = await resolveDirectorySpellings(['/work/a'], selection).catch(
      (cause: unknown) => cause
    );

    expect(failure).toBeInstanceOf(RemoteError);
  });
});
