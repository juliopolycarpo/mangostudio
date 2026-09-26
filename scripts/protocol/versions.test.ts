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
  WORKSPACE_DEPENDENCY_CRATES,
  workspaceDependencyVersion,
  workspaceVersion,
  writeVersions,
} from './versions';

const CARGO_TOML =
  '[workspace]\nmembers = ["crates/*"]\n\n[workspace.package]\nversion = "0.1.0"\nedition = "2024"\n\n' +
  '[workspace.dependencies]\n' +
  'mango-protocol = { path = "crates/mango-protocol", version = "0.1.0" }\n' +
  'mangostudio-runtime-contract = { path = "crates/mangostudio-runtime-contract", version = "0.1.0" }\n';
const CARGO_LOCK =
  '[[package]]\nname = "serde"\nversion = "1.0.0"\n\n[[package]]\nname = "mango-protocol"\nversion = "0.1.0"\n\n' +
  '[[package]]\nname = "mangostudio-runtime-contract"\nversion = "0.1.0"\n';

/** A throwaway repository root holding the protocol's lockstep manifests. */
class FakeRepository {
  constructor(readonly root: string) {}

  static async create(): Promise<FakeRepository> {
    const root = await mkdtemp(join(tmpdir(), 'mango-versions-'));
    const repo = new FakeRepository(root);
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
  it('reads each WORKSPACE_DEPENDENCY_CRATES entry', () => {
    for (const crateName of WORKSPACE_DEPENDENCY_CRATES) {
      expect(lockedCrateVersion(CARGO_LOCK, crateName)).toBe('0.1.0');
    }
  });

  it('names the missing entry', () => {
    expect(() =>
      lockedCrateVersion('[[package]]\nname = "serde"\nversion = "1.0.0"\n', 'mango-protocol')
    ).toThrow('Cargo.lock has no entry for mango-protocol.');
  });
});

describe('workspaceDependencyVersion', () => {
  it('reads each WORKSPACE_DEPENDENCY_CRATES entry under [workspace.dependencies]', () => {
    for (const crateName of WORKSPACE_DEPENDENCY_CRATES) {
      expect(workspaceDependencyVersion(CARGO_TOML, crateName)).toBe('0.1.0');
    }
  });

  it('names the missing entry', () => {
    expect(() =>
      workspaceDependencyVersion(
        '[workspace.dependencies]\nserde = { version = "1.0.0" }\n',
        'mango-protocol'
      )
    ).toThrow('Cargo.toml has no mango-protocol entry under [workspace.dependencies].');
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
  it('reads every manifest, including every WORKSPACE_DEPENDENCY_CRATES pin, in order', async () => {
    expect(await readVersions(repo.root)).toEqual([
      { file: 'packages/protocol/package.json', version: '0.1.0' },
      { file: 'Cargo.toml', version: '0.1.0' },
      { file: 'Cargo.toml ([workspace.dependencies] mango-protocol)', version: '0.1.0' },
      {
        file: 'Cargo.toml ([workspace.dependencies] mangostudio-runtime-contract)',
        version: '0.1.0',
      },
      { file: 'Cargo.lock (mango-protocol)', version: '0.1.0' },
      { file: 'Cargo.lock (mangostudio-runtime-contract)', version: '0.1.0' },
    ]);
  });

  it('names a mangostudio-runtime-contract lockfile drift', async () => {
    await repo.write(
      MANIFESTS.cargoLock,
      CARGO_LOCK.replace(
        'name = "mangostudio-runtime-contract"\nversion = "0.1.0"',
        'name = "mangostudio-runtime-contract"\nversion = "0.2.0"'
      )
    );

    const versions = await readVersions(repo.root);
    expect(() => assertLockstep(versions)).toThrow(
      'Cargo.lock (mangostudio-runtime-contract) has 0.2.0.'
    );
  });

  it('ignores the application version at the repository root', async () => {
    // The protocol ships on its own `protocol-v*` train. The root package.json
    // carries the application's version, which moves independently; reading it
    // here would make every application release fail the protocol lockstep.
    await repo.write('package.json', '{\n  "name": "root",\n  "version": "9.9.9"\n}\n');
    expect((await readVersions(repo.root)).map((entry) => entry.file)).not.toContain(
      'package.json'
    );
  });
});

describe('writeVersions', () => {
  it('rewrites the package manifest and every Cargo.toml version field, leaving the lock alone', async () => {
    await writeVersions('0.2.0', repo.root);
    const versions = await readVersions(repo.root);
    expect(versions.map((entry) => entry.version)).toEqual([
      '0.2.0',
      '0.2.0',
      '0.2.0',
      '0.2.0',
      '0.1.0',
      '0.1.0',
    ]);
    expect(await repo.read(MANIFESTS.protocolPackage)).toContain('"typebox": "1.3.13"');
    expect(await repo.read(MANIFESTS.cargoWorkspace)).toContain('edition = "2024"');
  });

  it('bumps every WORKSPACE_DEPENDENCY_CRATES pin together, not only the first one', async () => {
    // The regression this guards: fixing only mango-protocol's own pin would
    // leave mangostudio-runtime-contract's [workspace.dependencies] version
    // stale after a bump, passing check:versions right up until `cargo build
    // --locked` fails on the stale path-dependency requirement.
    await writeVersions('0.3.0', repo.root);
    const cargoToml = await repo.read(MANIFESTS.cargoWorkspace);
    for (const crateName of WORKSPACE_DEPENDENCY_CRATES) {
      expect(workspaceDependencyVersion(cargoToml, crateName)).toBe('0.3.0');
    }
  });

  it('leaves the application manifest at the repository root untouched', async () => {
    await repo.write('package.json', '{\n  "name": "root",\n  "version": "9.9.9"\n}\n');
    await writeVersions('0.2.0', repo.root);
    expect(await repo.read('package.json')).toContain('"version": "9.9.9"');
  });

  it('keeps manifests that already carry the version', async () => {
    await writeVersions('0.1.0', repo.root);
    const versions = await readVersions(repo.root);
    expect(versions.map((entry) => entry.version)).toEqual([
      '0.1.0',
      '0.1.0',
      '0.1.0',
      '0.1.0',
      '0.1.0',
      '0.1.0',
    ]);
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

  it('leaves the package manifest unchanged when workspace.package has no version', async () => {
    await repo.write(
      MANIFESTS.cargoWorkspace,
      '[workspace.package]\nedition = "2024"\n\n[workspace.dependencies]\n' +
        'mango-protocol = { path = "crates/mango-protocol", version = "0.1.0" }\n' +
        'mangostudio-runtime-contract = { path = "crates/mangostudio-runtime-contract", version = "0.1.0" }\n'
    );

    await expect(writeVersions('0.2.0', repo.root)).rejects.toThrow(
      'Cargo.toml [workspace.package] has no version field to rewrite.'
    );
    expect(await repo.read(MANIFESTS.protocolPackage)).toContain('"version": "0.1.0"');
  });

  it('refuses a Cargo.toml without a workspace.dependencies mango-protocol entry', async () => {
    await repo.write(
      MANIFESTS.cargoWorkspace,
      '[workspace.package]\nversion = "0.1.0"\n\n[workspace.dependencies]\nserde = { version = "1.0.0" }\n'
    );
    await expect(writeVersions('0.2.0', repo.root)).rejects.toThrow(
      'Cargo.toml has no mango-protocol entry under [workspace.dependencies].'
    );
  });

  it('leaves the package manifest unchanged when a later workspace dependency pin is missing', async () => {
    await repo.write(
      MANIFESTS.cargoWorkspace,
      '[workspace.package]\nversion = "0.1.0"\n\n[workspace.dependencies]\n' +
        'mango-protocol = { path = "crates/mango-protocol", version = "0.1.0" }\n'
    );

    await expect(writeVersions('0.2.0', repo.root)).rejects.toThrow(
      'Cargo.toml has no mangostudio-runtime-contract entry under [workspace.dependencies].'
    );
    expect(await repo.read(MANIFESTS.protocolPackage)).toContain('"version": "0.1.0"');
  });
});
