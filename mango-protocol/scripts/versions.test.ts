import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertLockstep,
  lockedCrateVersion,
  MANIFESTS,
  readVersions,
  SEMVER_PATTERN,
  workspaceVersion,
  writeVersions,
} from './versions';

const CARGO_TOML =
  '[workspace]\nmembers = ["crates/*"]\n\n[workspace.package]\nversion = "0.1.0"\nedition = "2024"\n';
const CARGO_LOCK =
  '[[package]]\nname = "serde"\nversion = "1.0.0"\n\n[[package]]\nname = "mango-protocol"\nversion = "0.1.0"\n';

/** A throwaway repository root holding the four manifests. */
class FakeRepository {
  constructor(readonly root: string) {}

  static async create(): Promise<FakeRepository> {
    const root = await mkdtemp(join(tmpdir(), 'mango-versions-'));
    const repo = new FakeRepository(root);
    await repo.write(MANIFESTS.rootPackage, '{\n  "name": "root",\n  "version": "0.1.0"\n}\n');
    await repo.write(
      MANIFESTS.protocolPackage,
      '{\n  "name": "@mangostudio/protocol",\n  "version": "0.1.0",\n  "dependencies": { "typebox": "1.3.13" }\n}\n'
    );
    await repo.write(MANIFESTS.cargoWorkspace, CARGO_TOML);
    await repo.write(MANIFESTS.cargoLock, CARGO_LOCK);
    return repo;
  }

  async write(file: string, text: string): Promise<void> {
    await Bun.write(join(this.root, file), text);
  }

  read(file: string): Promise<string> {
    return Bun.file(join(this.root, file)).text();
  }

  async destroy(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

let repo: FakeRepository;
beforeEach(async () => {
  repo = await FakeRepository.create();
});
afterEach(async () => {
  await repo.destroy();
});

describe('SEMVER_PATTERN', () => {
  it('accepts releases and pre-releases, refuses a leading v and partial versions', () => {
    expect(SEMVER_PATTERN.test('0.1.0')).toBe(true);
    expect(SEMVER_PATTERN.test('1.2.3-rc.1')).toBe(true);
    expect(SEMVER_PATTERN.test('v0.1.0')).toBe(false);
    expect(SEMVER_PATTERN.test('0.1')).toBe(false);
  });
});

describe('workspaceVersion', () => {
  it('reads the version under [workspace.package] only', () => {
    expect(
      workspaceVersion('[package]\nversion = "9.9.9"\n[workspace.package]\nversion = "0.1.0"\n')
    ).toBe('0.1.0');
  });

  it('names the missing section', () => {
    expect(() => workspaceVersion('[package]\nversion = "0.1.0"\n')).toThrow(
      'Cargo.toml has no version under [workspace.package].'
    );
  });
});

describe('lockedCrateVersion', () => {
  it('reads the mango-protocol entry', () => {
    expect(lockedCrateVersion(CARGO_LOCK)).toBe('0.1.0');
  });

  it('names the missing entry', () => {
    expect(() => lockedCrateVersion('[[package]]\nname = "serde"\nversion = "1.0.0"\n')).toThrow(
      'Cargo.lock has no entry for mango-protocol.'
    );
  });
});

describe('assertLockstep', () => {
  it('passes when every manifest agrees', () => {
    expect(() =>
      assertLockstep([
        { file: 'a', version: '0.1.0' },
        { file: 'b', version: '0.1.0' },
      ])
    ).not.toThrow();
  });

  it('names every manifest that drifted from the expectation', () => {
    expect(() =>
      assertLockstep(
        [
          { file: 'a', version: '0.1.0' },
          { file: 'b', version: '0.2.0' },
        ],
        '0.1.0'
      )
    ).toThrow('Versions are not in lockstep; expected 0.1.0 everywhere, but b has 0.2.0.');
  });
});

describe('readVersions', () => {
  it('reads all four manifests in order', async () => {
    expect(await readVersions(repo.root)).toEqual([
      { file: 'package.json', version: '0.1.0' },
      { file: 'packages/protocol/package.json', version: '0.1.0' },
      { file: 'Cargo.toml', version: '0.1.0' },
      { file: 'Cargo.lock', version: '0.1.0' },
    ]);
  });
});

describe('writeVersions', () => {
  it('rewrites the package manifests and the Cargo workspace, leaving the lock alone', async () => {
    await writeVersions('0.2.0', repo.root);
    const versions = await readVersions(repo.root);
    expect(versions.map((entry) => entry.version)).toEqual(['0.2.0', '0.2.0', '0.2.0', '0.1.0']);
    expect(await repo.read(MANIFESTS.protocolPackage)).toContain('"typebox": "1.3.13"');
    expect(await repo.read(MANIFESTS.cargoWorkspace)).toContain('edition = "2024"');
  });

  it('keeps manifests that already carry the version', async () => {
    await writeVersions('0.1.0', repo.root);
    const versions = await readVersions(repo.root);
    expect(versions.map((entry) => entry.version)).toEqual(['0.1.0', '0.1.0', '0.1.0', '0.1.0']);
  });

  it('refuses a version that is not semver', async () => {
    await expect(writeVersions('v0.2.0', repo.root)).rejects.toThrow(
      'Version "v0.2.0" is not semver; expected MAJOR.MINOR.PATCH with an optional pre-release.'
    );
  });

  it('refuses a Cargo.toml without a workspace package section', async () => {
    await repo.write(MANIFESTS.cargoWorkspace, '[workspace]\nmembers = []\n');
    await expect(writeVersions('0.2.0', repo.root)).rejects.toThrow(
      'Cargo.toml has no [workspace.package] section.'
    );
  });
});
