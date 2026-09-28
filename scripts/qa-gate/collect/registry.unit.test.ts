import { describe, expect, it } from 'bun:test';

import { BASE_REPOSITORY_FILES, makeFakeRepository } from '../testing/fake-repository';
import {
  type ComponentSpec,
  discoverComponents,
  type ExtraMapping,
  ownerOf,
  RegistryIntegrityError,
} from './registry';

const discover = (
  files: Readonly<Record<string, string | Error>>,
  extraMappings?: readonly ExtraMapping[]
) => discoverComponents({ ...makeFakeRepository(files), extraMappings });

const ids = (specs: readonly ComponentSpec[]): string[] => specs.map((spec) => spec.id);

const integrityProblems = async (promise: Promise<unknown>): Promise<readonly string[]> => {
  try {
    await promise;
  } catch (err) {
    if (err instanceof RegistryIntegrityError) return err.problems;
    throw err;
  }
  throw new Error('expected discovery to fail integrity, but it succeeded');
};

describe('discoverComponents', () => {
  it('discovers workspaces, crates by package name, and scripts; the excluded fuzz workspace is not a component', async () => {
    const specs = await discover(BASE_REPOSITORY_FILES);

    expect(ids(specs)).toEqual([
      'workspace:@x/api',
      'crate:alpha-crate',
      'crate:beta',
      'workspace:mangostudio',
      'scripts:scripts',
    ]);
    expect(specs.find((spec) => spec.name === 'alpha-crate')?.root).toBe('crates/alpha');
    expect(ids(specs)).not.toContain('crate:alpha-fuzz');
  });

  it('lists an added workspace and an added crate automatically', async () => {
    const specs = await discover({
      ...BASE_REPOSITORY_FILES,
      'apps/web/package.json': JSON.stringify({ name: '@x/web' }),
      'apps/web/src/index.tsx': 'export {};\n',
      'Cargo.toml': BASE_REPOSITORY_FILES['Cargo.toml'].replace(
        '"crates/beta"]',
        '"crates/beta", "crates/gamma"]'
      ),
      'crates/gamma/Cargo.toml': '[package]\nname = "gamma"\n',
      'crates/gamma/src/lib.rs': 'pub fn g() {}\n',
    });

    expect(ids(specs)).toContain('workspace:@x/web');
    expect(ids(specs)).toContain('crate:gamma');
    expect(specs).toHaveLength(7);
  });

  it('expands member globs and honours negated workspace globs', async () => {
    const specs = await discover({
      ...BASE_REPOSITORY_FILES,
      'package.json': JSON.stringify({ workspaces: ['apps/*', 'packages/*', '!packages/cli'] }),
      'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/alpha"]\n',
    }).catch((err: unknown) => err);

    // The negated packages/cli and the excluded crates/alpha are no longer
    // members and are not nested in one: integrity, not a silent drop.
    expect(specs).toBeInstanceOf(RegistryIntegrityError);
    const problems = (specs as RegistryIntegrityError).problems.join('\n');
    expect(problems).toContain('packages/cli/package.json is not a member');
    expect(problems).not.toContain('crates/alpha/Cargo.toml');
    expect(problems).not.toContain('crates/beta');
  });

  it('accepts the object form of package.json workspaces', async () => {
    const specs = await discover({
      ...BASE_REPOSITORY_FILES,
      'package.json': JSON.stringify({ workspaces: { packages: ['apps/*', 'packages/*'] } }),
    });

    expect(ids(specs)).toContain('workspace:@x/api');
    expect(ids(specs)).toContain('workspace:mangostudio');
  });

  it('records whether a type-check is defined for each component', async () => {
    const specs = await discover(BASE_REPOSITORY_FILES);
    const byId = Object.fromEntries(specs.map((spec) => [spec.id, spec.hasTsconfig]));

    expect(byId).toEqual({
      'workspace:@x/api': true,
      'crate:alpha-crate': false,
      'crate:beta': false,
      'workspace:mangostudio': false,
      'scripts:scripts': true,
    });
  });

  it('works with no Cargo.toml at all', async () => {
    const files = Object.fromEntries(
      Object.entries(BASE_REPOSITORY_FILES).filter(
        ([path]) => path !== 'Cargo.toml' && !path.startsWith('crates/')
      )
    );

    expect(ids(await discover(files))).toEqual([
      'workspace:@x/api',
      'workspace:mangostudio',
      'scripts:scripts',
    ]);
  });
});

describe('registry integrity', () => {
  it('fails, naming the files, when the scripts/ mapping is removed', async () => {
    const problems = await integrityProblems(discover(BASE_REPOSITORY_FILES, []));

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('2 tracked file(s) under scripts/ (e.g. scripts/tsconfig.json)');
    expect(problems[0]).toContain('owned by no component');
  });

  it('fails for a new top-level directory with tracked files, not silently dropping them', async () => {
    const problems = await integrityProblems(
      discover({ ...BASE_REPOSITORY_FILES, 'tools/gen.ts': 'export {};\n' })
    );

    expect(problems.join('\n')).toContain('1 tracked file(s) under tools/ (e.g. tools/gen.ts)');
  });

  it('allows prose, spec, dot-directories, browser specs and root files outside any component', async () => {
    await expect(discover(BASE_REPOSITORY_FILES)).resolves.toBeDefined();
  });

  it('fails for a Cargo manifest that is neither a member, excluded nor nested', async () => {
    const problems = await integrityProblems(
      discover({
        ...BASE_REPOSITORY_FILES,
        'crates/stray/Cargo.toml': '[package]\nname = "stray"\n',
        'crates/stray/src/lib.rs': 'pub fn s() {}\n',
      })
    );

    expect(problems.join('\n')).toContain('crates/stray/Cargo.toml is not a member');
  });

  it('fails for a package manifest outside the workspaces globs', async () => {
    const problems = await integrityProblems(
      discover({
        ...BASE_REPOSITORY_FILES,
        'libs/util/package.json': JSON.stringify({ name: '@x/util' }),
        'libs/util/index.ts': 'export {};\n',
      })
    );

    expect(problems.join('\n')).toContain('libs/util/package.json is not a member');
  });

  it('does not treat a manifest nested in a component as a second component', async () => {
    const specs = await discover({
      ...BASE_REPOSITORY_FILES,
      'apps/api/tests/fixtures/pkg/package.json': JSON.stringify({ name: 'fixture-pkg' }),
      'apps/api/tests/fixtures/pkg/index.ts': 'export {};\n',
    });

    expect(ids(specs)).not.toContain('workspace:fixture-pkg');
    expect(ownerOf(specs, 'apps/api/tests/fixtures/pkg/index.ts')?.id).toBe('workspace:@x/api');
  });

  it('attributes the excluded fuzz workspace to its parent crate once', async () => {
    const specs = await discover(BASE_REPOSITORY_FILES);

    expect(ownerOf(specs, 'crates/alpha/fuzz/fuzz_targets/one.rs')?.id).toBe('crate:alpha-crate');
  });

  it('fails when a mapping points at a directory with no tracked files', async () => {
    const problems = await integrityProblems(
      discover(BASE_REPOSITORY_FILES, [
        { kind: 'scripts', name: 'scripts', root: 'scripts' },
        { kind: 'scripts', name: 'tools', root: 'tools' },
      ])
    );

    expect(problems.join('\n')).toContain(
      'mapping scripts:tools has no tracked files under tools/'
    );
  });

  it('fails, with the invalid value, for a manifest that has no name', async () => {
    const problems = await integrityProblems(
      discover({
        ...BASE_REPOSITORY_FILES,
        'apps/api/package.json': JSON.stringify({ version: '1.0.0' }),
        'crates/beta/Cargo.toml': '[package]\nversion = "0.1.0"\n',
      })
    );

    expect(problems).toContain(
      'apps/api/package.json has name undefined; expected a non-empty string'
    );
    expect(problems).toContain(
      'crates/beta/Cargo.toml has [package].name undefined; expected a non-empty string'
    );
  });

  it.each([
    ['package.json is not JSON', { 'package.json': '{nope' }, 'package.json is not valid JSON'],
    ['package.json is an array', { 'package.json': '[]' }, 'expected a JSON object'],
    ['Cargo.toml is not TOML', { 'Cargo.toml': '[workspace' }, 'Cargo.toml is not valid TOML'],
    [
      'Cargo.toml has a root package',
      { 'Cargo.toml': '[package]\nname = "root"\n\n[workspace]\nmembers = []\n' },
      'declares a root [package]',
    ],
  ])('fails when the root %s', async (_label, override, message) => {
    const problems = await integrityProblems(discover({ ...BASE_REPOSITORY_FILES, ...override }));

    expect(problems.join('\n')).toContain(message);
  });

  it('reports every problem at once, not just the first', async () => {
    const problems = await integrityProblems(
      discover({ ...BASE_REPOSITORY_FILES, 'tools/gen.ts': 'x', 'lib/a.ts': 'y' }, [])
    );

    expect(problems.join('\n')).toContain('under scripts/');
    expect(problems.join('\n')).toContain('under tools/');
    expect(problems.join('\n')).toContain('under lib/');
  });
});

describe('ownerOf', () => {
  const spec = (name: string, root: string): ComponentSpec => ({
    id: `workspace:${name}`,
    kind: 'workspace',
    name,
    root,
    hasTsconfig: false,
  });
  const specs = [spec('outer', 'apps/outer'), spec('inner', 'apps/outer/inner')];

  it('assigns a file to the longest matching root so nested roots count once', () => {
    expect(ownerOf(specs, 'apps/outer/inner/a.ts')?.name).toBe('inner');
    expect(ownerOf(specs, 'apps/outer/a.ts')?.name).toBe('outer');
  });

  it('does not match a sibling that merely shares a name prefix', () => {
    expect(ownerOf(specs, 'apps/outer-two/a.ts')).toBeNull();
  });

  it('returns null for a file no component owns', () => {
    expect(ownerOf(specs, 'docs/guide.md')).toBeNull();
  });
});
