import { describe, expect, it } from 'bun:test';
import {
  type ContainerRuntimeSourceDeps,
  ContainerRuntimeSourceError,
  resolveContainerRuntimeBinary,
} from '../../../../src/modules/environments/domain/container-runtime-source';

const MANGO_HOME = '/home/j/.mango';
const BASE_DIR = '/repo';
const BYTES = new Uint8Array([0x7f, 0x45, 0x4c, 0x46]);
const LOADED = {
  bytes: BYTES,
  fromArchive: false,
  digest: 'sha256:abc',
  cached: true,
  offlineCache: false,
} as const;

function deps(
  overrides: Partial<ContainerRuntimeSourceDeps> = {}
): Partial<ContainerRuntimeSourceDeps> {
  return {
    version: '0.1.1',
    mangoHome: MANGO_HOME,
    baseDir: BASE_DIR,
    loadBytes: () => Promise.resolve({ ...LOADED }),
    fileExists: () => Promise.resolve(true),
    writeBinary: () => Promise.resolve(),
    markExecutable: () => Promise.resolve(),
    ...overrides,
  };
}

describe('resolveContainerRuntimeBinary in a source checkout', () => {
  it('mounts the build the checkout made for that platform', async () => {
    const result = await resolveContainerRuntimeBinary('linux-x64-musl', deps({ version: 'dev' }));

    expect(result).toEqual({
      path: '/repo/.mango/out/linux-x64-musl/mangostudio-runtime',
      offlineCache: false,
    });
  });

  it('never asks a release for a version no tag will ever carry', async () => {
    let fetched = false;
    await resolveContainerRuntimeBinary(
      'linux-x64',
      deps({
        version: 'dev',
        loadBytes: () => {
          fetched = true;
          return Promise.resolve({ ...LOADED });
        },
      })
    );

    expect(fetched).toBe(false);
  });

  it('marks the checkout build executable, which nothing else on this path does', async () => {
    const marked: string[] = [];
    const result = await resolveContainerRuntimeBinary(
      'linux-x64-musl',
      deps({
        version: 'dev',
        markExecutable: (target: string) => {
          marked.push(target);
          return Promise.resolve();
        },
      })
    );

    expect(result.offlineCache).toBe(false);
    expect(marked).toEqual([result.path]);
  });

  it('names the command that produces a build there is not one of', async () => {
    const attempt = resolveContainerRuntimeBinary(
      'linux-arm64',
      deps({ version: 'dev', fileExists: () => Promise.resolve(false) })
    );

    await expect(attempt).rejects.toBeInstanceOf(ContainerRuntimeSourceError);
    await expect(attempt).rejects.toThrow(/--target=bun-linux-arm64/);
  });
});

describe('resolveContainerRuntimeBinary from a release', () => {
  it('writes the verified bytes into the documented cache and returns that path', async () => {
    const written: { path?: string; bytes?: Uint8Array } = {};
    const result = await resolveContainerRuntimeBinary(
      'linux-x64',
      deps({
        // The fetch's own cache write is best-effort; this is the run where it
        // did not land, so the bytes still have to reach disk here.
        loadBytes: () => Promise.resolve({ ...LOADED, cached: false }),
        writeBinary: (target: string, bytes: Uint8Array) => {
          written.path = target;
          written.bytes = bytes;
          return Promise.resolve();
        },
      })
    );

    expect(result).toEqual({
      path: '/home/j/.mango/runtime-cache/0.1.1/mangostudio-runtime-0.1.1-linux-x64',
      offlineCache: false,
    });
    expect(written.path).toBe(result.path);
    expect(written.bytes).toEqual(BYTES);
  });

  it('replaces a leftover cache file when the loader could not write', async () => {
    const written: { path?: string; bytes?: Uint8Array } = {};
    const result = await resolveContainerRuntimeBinary(
      'linux-x64',
      deps({
        loadBytes: () => Promise.resolve({ ...LOADED, cached: false }),
        fileExists: () => Promise.resolve(true),
        writeBinary: (target: string, bytes: Uint8Array) => {
          written.path = target;
          written.bytes = bytes;
          return Promise.resolve();
        },
      })
    );

    expect(written.path).toBe(result.path);
    expect(written.bytes).toEqual(BYTES);
  });

  it('marks a cached binary executable instead of rewriting it', async () => {
    let wrote = false;
    const marked: string[] = [];
    const result = await resolveContainerRuntimeBinary(
      'linux-x64',
      deps({
        writeBinary: () => {
          wrote = true;
          return Promise.resolve();
        },
        markExecutable: (target: string) => {
          marked.push(target);
          return Promise.resolve();
        },
      })
    );

    expect(result.offlineCache).toBe(false);
    expect(wrote).toBe(false);
    expect(marked).toEqual([result.path]);
  });

  it('preserves the loader flag when the bytes came from the offline cache', async () => {
    const result = await resolveContainerRuntimeBinary(
      'linux-x64',
      deps({
        loadBytes: () => Promise.resolve({ ...LOADED, offlineCache: true }),
      })
    );

    expect(result).toEqual({
      path: '/home/j/.mango/runtime-cache/0.1.1/mangostudio-runtime-0.1.1-linux-x64',
      offlineCache: true,
    });
  });

  it('resolves a canary hub onto the rolling asset name', async () => {
    const result = await resolveContainerRuntimeBinary(
      'linux-x64',
      deps({ version: '0.1.1-canary.gabc1234' })
    );

    // The cache directory is the hub's own version; the asset carries the
    // rolling name, which is what the release actually published.
    expect(result).toEqual({
      path: '/home/j/.mango/runtime-cache/0.1.1-canary.gabc1234/mangostudio-runtime-0.1.1-canary-linux-x64',
      offlineCache: false,
    });
  });

  it('refuses an archive-only release rather than growing a second unpack path', async () => {
    const attempt = resolveContainerRuntimeBinary(
      'linux-arm64-musl',
      deps({
        loadBytes: () => Promise.resolve({ ...LOADED, fromArchive: true }),
      })
    );

    await expect(attempt).rejects.toThrow(/publishes no standalone linux-arm64-musl runtime/);
  });

  it('reports a failed fetch as a source problem, keeping the cause', async () => {
    const attempt = resolveContainerRuntimeBinary(
      'linux-x64',
      deps({ loadBytes: () => Promise.reject(new Error('checksum mismatch')) })
    );

    await expect(attempt).rejects.toThrow(/checksum mismatch/);
  });

  it('forwards cancellation into the release fetch', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    await resolveContainerRuntimeBinary('linux-x64', {
      ...deps({
        loadBytes: (_platform, overrides) => {
          seen = overrides?.signal;
          return Promise.resolve({ ...LOADED });
        },
      }),
      signal: controller.signal,
    });

    expect(seen).toBe(controller.signal);
  });

  it('refuses to fetch when the attempt is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    let fetched = false;

    const attempt = resolveContainerRuntimeBinary('linux-x64', {
      ...deps({
        loadBytes: () => {
          fetched = true;
          return Promise.resolve({ ...LOADED });
        },
      }),
      signal: controller.signal,
    });

    await expect(attempt).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetched).toBe(false);
  });

  it('keeps a cancelled download as cancellation, not a missing release', async () => {
    const controller = new AbortController();
    const attempt = resolveContainerRuntimeBinary('linux-x64', {
      ...deps({
        loadBytes: () => {
          controller.abort();
          return Promise.reject(new Error('Could not download: Request was cancelled.'));
        },
      }),
      signal: controller.signal,
    });

    await expect(attempt).rejects.toMatchObject({ name: 'AbortError' });
  });
});
