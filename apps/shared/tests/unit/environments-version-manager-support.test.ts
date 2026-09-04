import { describe, expect, it } from 'bun:test';
import {
  type ManagedVersionFileSystem,
  readManagedVersions,
} from '@mangostudio/shared/environments/detection';

const VERSIONS_ROOT = '/home/tester/.nvm/versions/node';

const nodeBinaryPathFor = (entry: string) => `${VERSIONS_ROOT}/${entry}/bin/node`;

/**
 * `entries` is what `readDirectory` lists, `files` what `pathExists` accepts,
 * and `symlinks` what `realpath` resolves. A path listed in `realpathFailures`
 * throws instead, standing in for a dangling link.
 */
class FakeManagedVersionFileSystem implements ManagedVersionFileSystem {
  readonly #entries: readonly string[];
  readonly #files: ReadonlySet<string>;
  readonly #symlinks: ReadonlyMap<string, string>;
  readonly #realpathFailures: ReadonlySet<string>;

  constructor(fixture: {
    readonly entries: readonly string[];
    readonly files?: readonly string[];
    readonly symlinks?: Readonly<Record<string, string>>;
    readonly realpathFailures?: readonly string[];
  }) {
    this.#entries = fixture.entries;
    this.#files = new Set(fixture.files ?? fixture.entries.map(nodeBinaryPathFor));
    this.#symlinks = new Map(Object.entries(fixture.symlinks ?? {}));
    this.#realpathFailures = new Set(fixture.realpathFailures ?? []);
  }

  pathExists(path: string): boolean {
    return this.#files.has(path);
  }

  readDirectory(): Promise<readonly string[]> {
    return Promise.resolve(this.#entries);
  }

  realpath(path: string): Promise<string> {
    if (this.#realpathFailures.has(path)) return Promise.reject(new Error(`ENOENT: ${path}`));
    return Promise.resolve(this.#symlinks.get(path) ?? path);
  }
}

describe('readManagedVersions', () => {
  it('returns installed versions newest first, resolved through realpath', async () => {
    const fs = new FakeManagedVersionFileSystem({
      entries: ['v20.11.0', 'v24.18.0', 'v22.9.0'],
      symlinks: { [nodeBinaryPathFor('v24.18.0')]: '/opt/node-24.18.0/bin/node' },
    });

    expect(await readManagedVersions(fs, VERSIONS_ROOT, nodeBinaryPathFor)).toEqual([
      { version: '24.18.0', path: '/opt/node-24.18.0/bin/node' },
      { version: '22.9.0', path: nodeBinaryPathFor('v22.9.0') },
      { version: '20.11.0', path: nodeBinaryPathFor('v20.11.0') },
    ]);
  });

  it('skips directories that are not a version, and versions with no binary', async () => {
    const fs = new FakeManagedVersionFileSystem({
      entries: ['v24.18.0', 'lts', '24.18', 'v22.9.0'],
      files: [nodeBinaryPathFor('v24.18.0')],
    });

    expect(await readManagedVersions(fs, VERSIONS_ROOT, nodeBinaryPathFor)).toEqual([
      { version: '24.18.0', path: nodeBinaryPathFor('v24.18.0') },
    ]);
  });

  it('keeps the layout path when realpath fails, since the binary is known to exist', async () => {
    const fs = new FakeManagedVersionFileSystem({
      entries: ['v24.18.0'],
      realpathFailures: [nodeBinaryPathFor('v24.18.0')],
    });

    expect(await readManagedVersions(fs, VERSIONS_ROOT, nodeBinaryPathFor)).toEqual([
      { version: '24.18.0', path: nodeBinaryPathFor('v24.18.0') },
    ]);
  });

  it('reads an unlistable versions root as no versions rather than throwing', async () => {
    const fs: ManagedVersionFileSystem = {
      pathExists: () => true,
      readDirectory: () => Promise.reject(new Error('ENOENT')),
      realpath: (path) => Promise.resolve(path),
    };

    expect(await readManagedVersions(fs, VERSIONS_ROOT, nodeBinaryPathFor)).toEqual([]);
  });
});
