import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  assertDeclaredSources,
  assertTailwindInputsUnchanged,
  createTailwindInputs,
  frontendBuildCacheArguments,
  parseTailwindInputs,
  readSourceInventory,
  tailwindInputsAreCurrent,
} from '../../src/frontend-build/host';

const fixtures: string[] = [];
afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const repository = mkdtempSync(join(tmpdir(), 'tailwind-inputs-'));
  fixtures.push(repository);
  const project = join(repository, 'apps/frontend');
  for (const path of [
    '.git/info',
    'apps/frontend/src/ignored',
    'apps/frontend/scripts',
    'apps/shared/src/frontend-build',
  ])
    mkdirSync(join(repository, path), { recursive: true });
  for (const path of [
    'apps/frontend/src/main.tsx',
    'apps/frontend/index.html',
    'apps/frontend/scripts/routes.ts',
    'apps/frontend/scripts/tailwind.ts',
    'apps/shared/src/frontend-build/host.ts',
  ])
    writeFileSync(join(repository, path), 'initial');
  const config = {
    version: 1,
    defaultSources: [
      { base: '.', pattern: 'src/**/*', negated: false },
      { base: '.', pattern: 'index.html', negated: false },
    ],
    additionalRoots: [] as { path: string; kind: string }[],
  };
  const save = () => writeFileSync(join(project, 'tailwind-inputs.json'), JSON.stringify(config));
  save();
  const inventory = () => readSourceInventory(project, repository);
  const capture = () =>
    createTailwindInputs(inventory(), inventory().defaultSources, [join(project, 'src/main.tsx')]);
  return { repository, project, config, save, inventory, capture };
}
function turboInputs(project: string): string[] {
  const real = JSON.parse(
    readFileSync(join(import.meta.dir, '../../../frontend/turbo.json'), 'utf8')
  );
  writeFileSync(join(project, 'turbo.json'), JSON.stringify(real));
  return real.tasks.build.inputs;
}

describe('frontend build source inventory', () => {
  test('accepts bounded defaults and declared sibling directory/file sources', () => {
    const f = fixture();
    mkdirSync(join(f.repository, 'packages/ui/src'), { recursive: true });
    writeFileSync(join(f.repository, 'packages/ui/card.tsx'), 'card');
    f.config.additionalRoots.push(
      { path: '../../packages/ui/src', kind: 'directory' },
      { path: '../../packages/ui/card.tsx', kind: 'file' }
    );
    f.save();
    expect(() =>
      assertDeclaredSources(f.inventory(), [
        { base: join(f.repository, 'packages/ui'), pattern: 'src/**/*.tsx', negated: false },
        { base: join(f.repository, 'packages/ui'), pattern: 'card.tsx', negated: true },
      ])
    ).not.toThrow();
    expect(() =>
      assertDeclaredSources(f.inventory(), [
        { base: f.repository, pattern: 'undeclared/**/*', negated: false },
      ])
    ).toThrow('undeclared: expected source declared by tailwind-inputs.json');
  });
  test('names invalid version, absolute roots and repository escapes', () => {
    const f = fixture();
    writeFileSync(join(f.project, 'tailwind-inputs.json'), '{"version":2}');
    expect(f.inventory).toThrow('expected version 1');
    f.config.additionalRoots.push({ path: '/outside', kind: 'directory' });
    f.save();
    expect(f.inventory).toThrow('expected additional root');
    f.config.additionalRoots[0].path = '../../../outside';
    f.save();
    expect(f.inventory).toThrow('expected declared source inside this repository');
  });
  test('rejects nested repository descendants and source-root ancestors', () => {
    const f = fixture();
    mkdirSync(join(f.project, 'src/nested/.git'), { recursive: true });
    expect(f.capture).toThrow('nested/.git: expected declared source');
    rmSync(join(f.project, 'src/nested'), { recursive: true });
    mkdirSync(join(f.repository, 'node_modules/vendor/src'), { recursive: true });
    writeFileSync(join(f.repository, 'node_modules/vendor/.git'), 'gitdir: elsewhere');
    f.config.additionalRoots.push({ path: '../../node_modules/vendor/src', kind: 'directory' });
    f.save();
    expect(f.inventory).toThrow('vendor/.git: expected declared source');
  });
  test('tracks symlink identity, rejects outside targets and cycles', () => {
    const f = fixture();
    writeFileSync(join(f.project, 'src/target.tsx'), 'one');
    symlinkSync('target.tsx', join(f.project, 'src/link.tsx'));
    const before = f.capture();
    writeFileSync(join(f.project, 'src/target.tsx'), 'two');
    expect(tailwindInputsAreCurrent(f.repository, before)).toBe(false);
    symlinkSync('/etc/passwd', join(f.project, 'src/escape'));
    expect(f.capture).toThrow('escape: expected declared source');
    rmSync(join(f.project, 'src/escape'));
    symlinkSync('.', join(f.project, 'src/cycle'));
    expect(f.capture).toThrow('cycle: expected source symlink without a cycle');
  });
});

describe('frontend build content stamps', () => {
  test('validates exact lists, paths, digest, reuse and supported shapes', () => {
    const f = fixture();
    const stamp = f.capture();
    expect(parseTailwindInputs(stamp)).toEqual(stamp);
    for (const invalid of [
      {},
      { ...stamp, version: 2 },
      { ...stamp, digest: 'xyz' },
      { ...stamp, reuse: 'maybe' },
      { ...stamp, roots: [{ path: { base: 'absolute', path: '/tmp' }, kind: 'directory' }] },
      { ...stamp, files: [{ base: 'repository', path: '../escape' }] },
      { ...stamp, controls: [{ path: { base: 'repository', path: 'x' }, kind: 'anything' }] },
      { ...stamp, sources: [{ base: '/tmp', pattern: '**/*', negated: false }] },
      { ...stamp, files: [...stamp.files, stamp.files[0]] },
    ])
      expect(parseTailwindInputs(invalid)).toBeNull();
  });
  test('fingerprints containing directories for filename and directory-component globs', () => {
    const f = fixture();
    for (const pattern of ['src/card-*.tsx', 'src/feature-*/**/*.tsx']) {
      f.config.defaultSources = [{ base: '.', pattern, negated: false }];
      f.save();
      mkdirSync(join(f.project, 'src/feature-chat'), { recursive: true });
      const path = join(
        f.project,
        pattern.includes('feature-') ? 'src/feature-chat/card.tsx' : 'src/card-chat.tsx'
      );
      writeFileSync(path, 'original class');
      let before = createTailwindInputs(f.inventory(), [], []);
      writeFileSync(path, 'changed class');
      expect(
        tailwindInputsAreCurrent(f.repository, before),
        `${pattern}: changed matched file must invalidate`
      ).toBe(false);
      before = createTailwindInputs(f.inventory(), [], []);
      const added = join(dirname(path), 'card-added.tsx');
      writeFileSync(added, 'added class');
      expect(
        tailwindInputsAreCurrent(f.repository, before),
        `${pattern}: added matched file must invalidate`
      ).toBe(false);
      before = createTailwindInputs(f.inventory(), [], []);
      rmSync(added);
      expect(
        tailwindInputsAreCurrent(f.repository, before),
        `${pattern}: deleted matched file must invalidate`
      ).toBe(false);
      expect(f.inventory().roots).toEqual([
        { path: { base: 'repository', path: 'apps/frontend/src' }, kind: 'directory' },
      ]);
      const inputs = turboInputs(f.project);
      writeFileSync(
        join(f.project, 'turbo.json'),
        JSON.stringify({
          tasks: {
            build: {
              inputs: inputs.filter((input) => input !== '$TURBO_ROOT$/apps/frontend/src/**'),
            },
          },
        })
      );
      expect(() => frontendBuildCacheArguments(f.repository)).toThrow(
        'expected Turbo build input $TURBO_ROOT$/apps/frontend/src/**'
      );
    }
    f.config.defaultSources = [{ base: '.', pattern: 'src/main.tsx', negated: false }];
    f.save();
    expect(f.inventory().roots).toEqual([
      { path: { base: 'repository', path: 'apps/frontend/src/main.tsx' }, kind: 'file' },
    ]);
  });

  test('captures ignored/untracked add, edit, delete and same-mtime changes', () => {
    const f = fixture();
    writeFileSync(join(f.project, '.gitignore'), 'src/ignored/');
    for (const operation of ['add', 'edit', 'delete']) {
      const before = f.capture();
      const path = join(f.project, 'src/ignored/new.tsx');
      if (operation === 'delete') rmSync(path);
      else {
        writeFileSync(path, operation);
        utimesSync(path, 1000, 1000);
      }
      expect(tailwindInputsAreCurrent(f.repository, before), operation).toBe(false);
      expect(() => assertTailwindInputsUnchanged(f.repository, before)).toThrow(
        'expected unchanged Tailwind inputs'
      );
    }
    const before = f.capture();
    writeFileSync(join(f.project, 'scripts/routes.test.ts'), 'test');
    writeFileSync(join(f.project, 'scripts/generation.log'), 'log');
    expect(tailwindInputsAreCurrent(f.repository, before)).toBe(true);
  });
  test('captures optional control creation, edits and deletion including direct Git excludes', () => {
    const f = fixture();
    for (const path of [
      join(f.repository, '.gitignore'),
      join(f.repository, '.ignore'),
      join(f.project, '.ignore'),
      join(f.repository, '.git/info/exclude'),
    ]) {
      let before = f.capture();
      writeFileSync(path, 'src/ignored/');
      utimesSync(path, 1000, 1000);
      expect(tailwindInputsAreCurrent(f.repository, before), path).toBe(false);
      before = f.capture();
      writeFileSync(path, 'different');
      utimesSync(path, 1000, 1000);
      expect(tailwindInputsAreCurrent(f.repository, before), path).toBe(false);
      before = f.capture();
      rmSync(path);
      expect(tailwindInputsAreCurrent(f.repository, before), path).toBe(false);
    }
  });
  test('retains generated source content while ignoring identical-byte mtime churn', () => {
    const f = fixture();
    const path = join(f.project, 'src/routeTree.gen.ts');
    writeFileSync(path, 'route');
    const before = f.capture();
    utimesSync(path, 1000, 1000);
    expect(tailwindInputsAreCurrent(f.repository, before)).toBe(true);
    writeFileSync(path, 'changed route');
    expect(tailwindInputsAreCurrent(f.repository, before)).toBe(false);
  });
  test('fails closed on a required input removal and never blesses postcompile changes', () => {
    const f = fixture();
    const before = f.capture();
    writeFileSync(join(f.project, 'src/main.tsx'), 'changed during compilation');
    expect(() => assertTailwindInputsUnchanged(f.repository, before)).toThrow(
      'expected unchanged Tailwind inputs'
    );
    expect(before.digest).not.toBe(f.capture().digest);
    rmSync(join(f.project, 'scripts/tailwind.ts'));
    expect(() => tailwindInputsAreCurrent(f.repository, before)).toThrow(
      'tailwind.ts: expected required build input'
    );
  });
});

describe('frontend Turbo prelookup policy', () => {
  test('keeps direct repositories cacheable and disables linked/absent-marker caches', () => {
    const f = fixture();
    turboInputs(f.project);
    expect(frontendBuildCacheArguments(f.repository)).toEqual([]);
    rmSync(join(f.repository, '.git'), { recursive: true });
    writeFileSync(join(f.repository, '.git'), 'gitdir: /elsewhere');
    expect(frontendBuildCacheArguments(f.repository)).toEqual(['--cache=local:,remote:']);
    expect(tailwindInputsAreCurrent(f.repository, f.capture())).toBe(false);
    rmSync(join(f.repository, '.git'));
    expect(frontendBuildCacheArguments(f.repository)).toEqual(['--cache=local:,remote:']);
  });
  test('disables lookup for inherited outside controls and detects their creation/deletion', () => {
    const f = fixture();
    turboInputs(f.project);
    const parent = mkdtempSync(join(tmpdir(), 'tailwind-parent-'));
    fixtures.push(parent);
    const repository = join(parent, 'repo');
    // Move the fixture below an isolated ancestor so no shared parent control is modified.
    renameSync(f.repository, repository);
    const project = join(repository, 'apps/frontend');
    const inventory = () => readSourceInventory(project, repository);
    const before = createTailwindInputs(inventory(), [], []);
    writeFileSync(join(parent, '.ignore'), 'repo/apps/frontend/src/ignored');
    expect(frontendBuildCacheArguments(repository)).toEqual(['--cache=local:,remote:']);
    expect(tailwindInputsAreCurrent(repository, before)).toBe(false);
    const uncacheable = createTailwindInputs(inventory(), [], []);
    expect(uncacheable.reuse).toBe('always-build');
    rmSync(join(parent, '.ignore'));
    expect(frontendBuildCacheArguments(repository)).toEqual([]);
    expect(tailwindInputsAreCurrent(repository, uncacheable)).toBe(false);
  });
  test('names missing root/config/control input coverage before any cache lookup', () => {
    const f = fixture();
    const inputs = turboInputs(f.project);
    writeFileSync(
      join(f.project, 'turbo.json'),
      JSON.stringify({
        tasks: { build: { inputs: inputs.filter((input) => input !== 'scripts/tailwind.ts') } },
      })
    );
    expect(() => frontendBuildCacheArguments(f.repository)).toThrow(
      'expected Turbo build input scripts/tailwind.ts declared in turbo.json'
    );
    f.config.additionalRoots.push({ path: '../../packages/ui', kind: 'directory' });
    f.save();
    turboInputs(f.project);
    expect(() => frontendBuildCacheArguments(f.repository)).toThrow('$TURBO_ROOT$/packages/ui/**');
  });
});
