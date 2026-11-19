import { afterEach, describe, expect, it } from 'bun:test';

import { RemoteError } from '@mangostudio/protocol';

import { createDirectorySpellingResolver } from '../../../../src/modules/git/infrastructure/runtime-directories';
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

describe('createDirectorySpellingResolver', () => {
  it('adds the runtime canonical form of a directory that resolves elsewhere', async () => {
    runtime = installFakeWorkspaceRuntime({ '/tmp/x/feature': '/private/tmp/x/feature' });

    const resolved = await createDirectorySpellingResolver(selection).resolve(['/tmp/x/feature']);

    expect(resolved.get('/tmp/x/feature')).toEqual(['/tmp/x/feature', '/private/tmp/x/feature']);
  });

  it('answers a directory that does not exist with the spelling it was given', async () => {
    runtime = installFakeWorkspaceRuntime({});

    const resolved = await createDirectorySpellingResolver(selection).resolve(['/work/missing']);

    expect(resolved.get('/work/missing')).toEqual(['/work/missing']);
  });

  it('asks once per distinct path, however often it is repeated', async () => {
    runtime = installFakeWorkspaceRuntime({ '/work/a': '/work/a', '/work/b': '/real/b' });

    const resolved = await createDirectorySpellingResolver(selection).resolve([
      '/work/a',
      '/work/b',
      '/work/a',
      '/work/b',
    ]);

    expect([...runtime.validated].sort()).toEqual(['/work/a', '/work/b']);
    expect(resolved.size).toBe(2);
  });

  it('asks once per path across every call the resolver serves', async () => {
    runtime = installFakeWorkspaceRuntime({ '/work/a': '/real/a', '/work/b': '/real/b' });
    const resolver = createDirectorySpellingResolver(selection);

    await resolver.resolve(['/work/a']);
    const second = await resolver.resolve(['/work/a', '/work/b']);

    expect([...runtime.validated].sort()).toEqual(['/work/a', '/work/b']);
    expect(second.get('/work/a')).toEqual(['/work/a', '/real/a']);
  });

  it('makes no runtime request for an empty list', async () => {
    runtime = installFakeWorkspaceRuntime({});

    expect((await createDirectorySpellingResolver(selection).resolve([])).size).toBe(0);
    expect(runtime.validated).toEqual([]);
  });

  it('treats a path the runtime rejects as unresolved rather than failing the list', async () => {
    runtime = installFakeWorkspaceRuntime({
      '/work/odd': new RemoteError('INVALID_PARAMS', 'bad path', { kind: 'workdir_validation' }),
    });

    const resolved = await createDirectorySpellingResolver(selection).resolve(['/work/odd']);

    expect(resolved.get('/work/odd')).toEqual(['/work/odd']);
  });

  it.each(['ELOOP', 'ESTALE', 'EIO', 'ENAMETOOLONG'])(
    'treats a directory the runtime fails on with %s as unresolved and still answers the rest',
    async (errno) => {
      runtime = installFakeWorkspaceRuntime({
        '/work/broken': new RemoteError('INTERNAL', `failed to validate path: ${errno}`),
        '/work/ok': '/real/ok',
      });

      const resolved = await createDirectorySpellingResolver(selection).resolve([
        '/work/broken',
        '/work/ok',
      ]);

      expect(resolved.get('/work/broken')).toEqual(['/work/broken']);
      expect(resolved.get('/work/ok')).toEqual(['/work/ok', '/real/ok']);
    }
  );

  it.each(['UNAVAILABLE', 'TIMEOUT', 'CANCELLED', 'PROTOCOL_MISMATCH'])(
    'lets a %s failure through instead of guessing the directory is unresolved',
    async (code) => {
      runtime = installFakeWorkspaceRuntime({
        '/work/a': new RemoteError(code, 'connection lost'),
      });

      const failure = await createDirectorySpellingResolver(selection)
        .resolve(['/work/a'])
        .catch((cause: unknown) => cause);

      expect(failure).toBeInstanceOf(RemoteError);
      expect((failure as RemoteError).code).toBe(code);
    }
  );

  it('rejects at once when the signal aborts while the runtime never answers', async () => {
    runtime = installFakeWorkspaceRuntime({}, { hanging: ['/work/hung'] });
    const controller = new AbortController();

    const pending = createDirectorySpellingResolver(selection, controller.signal).resolve([
      '/work/hung',
    ]);
    setTimeout(() => controller.abort(), 10);
    const outcome = await Promise.race([
      pending.catch((cause: unknown) => cause),
      new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 1_000)),
    ]);

    expect((outcome as Error).name).toBe('AbortError');
  });
});
