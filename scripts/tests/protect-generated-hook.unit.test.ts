import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  candidatePaths,
  extractTouchedFilePath,
  findProtectedFile,
  isInsideRepo,
  runProtectGeneratedHook,
  toRepoPath,
} from '../../.claude/hooks/protect-generated.mjs';

const repoRoot = join(import.meta.dir, '..', '..');
const tempDirs: string[] = [];

async function makeTempDir() {
  const path = await mkdtemp(join(tmpdir(), 'mango-protect-generated-'));
  tempDirs.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('protect-generated hook paths', () => {
  it('extracts touched files from Claude hook payloads', () => {
    const editInput = JSON.stringify({ tool_input: { file_path: 'apps/api/src/app.ts' } });
    const notebookInput = JSON.stringify({ tool_input: { notebook_path: 'docs/demo.ipynb' } });

    expect(extractTouchedFilePath(editInput)).toBe('apps/api/src/app.ts');
    expect(extractTouchedFilePath(notebookInput)).toBe('docs/demo.ipynb');
    expect(extractTouchedFilePath('not json')).toBe('');
  });

  it('scopes protection to files inside the repo', () => {
    const root = join('workspace', 'mangostudio');

    expect(isInsideRepo(join(root, 'README.md'), root)).toBe(true);
    expect(isInsideRepo(join('workspace', 'other', 'README.md'), root)).toBe(false);
  });

  it('accepts dot-prefixed descendants without admitting parent traversal', () => {
    // These call the real host functions: Windows runners exercise native drive
    // and separator handling, rather than a POSIX simulation of Windows paths.
    const root = resolve('workspace', 'mangostudio');
    for (const name of ['..notes', '...notes', '.notes']) {
      expect(isInsideRepo(join(root, name, 'sample.rs'), root)).toBe(true);
      expect(toRepoPath(join(root, name, 'sample.rs'), root)).toBe(`${name}/sample.rs`);
    }
    for (const outside of [
      root,
      resolve(root, '..'),
      resolve(root, '..', 'outside'),
      join(resolve(root, '..'), 'mangostudio-other', 'sample.rs'),
    ]) {
      expect(isInsideRepo(outside, root)).toBe(false);
      expect(toRepoPath(outside, root)).toBeUndefined();
    }
    if (process.platform === 'win32') {
      expect(isInsideRepo(`${root[0] === 'C' ? 'D' : 'C'}:\\outside\\sample.rs`, root)).toBe(false);
      expect(isInsideRepo(`${root}/../outside/sample.rs`, root)).toBe(false);
    }
  });

  it('keeps repo-relative generated-file fallback from a dot-prefixed cwd', () => {
    const root = resolve('workspace', 'mangostudio');
    const cwd = join(root, '..notes');
    expect(candidatePaths('bun.lock', cwd, root)).toEqual([
      join(cwd, 'bun.lock'),
      join(root, 'bun.lock'),
    ]);
    expect(runProtectGeneratedHook(JSON.stringify({ cwd, path: 'bun.lock' }), root).blocked).toBe(
      true
    );
    expect(
      runProtectGeneratedHook(
        JSON.stringify({ cwd: resolve(root, '..', 'outside'), path: 'bun.lock' }),
        root
      ).blocked
    ).toBe(false);
  });

  it('lists cwd-relative paths before repo-root ones only for a cwd inside the repo', () => {
    const root = resolve('/workspace', 'mangostudio');
    const outside = resolve('/workspace', 'other');
    const nested = join(root, 'crates', 'foo');

    expect(candidatePaths('src/lib.rs', nested, root)).toEqual([
      join(nested, 'src', 'lib.rs'),
      join(root, 'src', 'lib.rs'),
    ]);
    expect(candidatePaths('src/lib.rs', root, root)).toEqual([join(root, 'src', 'lib.rs')]);
    expect(candidatePaths('lib.rs', outside, root)).toEqual([join(outside, 'lib.rs')]);
    expect(candidatePaths(join(nested, 'lib.rs'), root, root)).toEqual([join(nested, 'lib.rs')]);
    expect(candidatePaths('', root, root)).toEqual([]);
  });
});

describe('Claude protect-generated hook', () => {
  const root = join('/workspace', 'mangostudio');

  it.each([
    ['CHANGELOG.md', 'bun run changelog'],
    ['packages/protocol/CHANGELOG.md', 'bun run protocol:release:prepare'],
    ['apps/frontend/src/routeTree.gen.ts', 'bun run --filter @mangostudio/frontend routes'],
    ['bun.lock', 'bun install'],
    ['Cargo.lock', 'cargo update'],
    ['crates/mango-protocol/fuzz/Cargo.lock', 'cargo update -w --manifest-path'],
    ['apps/shared/src/runtime-contract/generated/catalog.json', 'bun run contracts:emit'],
  ])('protects generated file %s', (path, regenerate) => {
    const match = findProtectedFile(join(root, path), root);

    expect(match?.path).toBe(path);
    expect(match?.regenerate).toContain(regenerate);
  });

  it('protects generated files inside a nested agent worktree', () => {
    const match = findProtectedFile(join(root, '.claude', 'worktrees', 'wt', 'bun.lock'), root);

    expect(match?.path).toBe('bun.lock');
  });

  it('protects generated paths through directory aliases, including new files', async () => {
    const physicalRoot = await makeTempDir();
    const generated = join(physicalRoot, 'apps', 'shared', 'src', 'runtime-contract', 'generated');
    const alias = join(physicalRoot, 'alias');
    await mkdir(generated, { recursive: true });
    await symlink(generated, alias, 'junction');
    await writeFile(join(generated, 'existing.json'), '{}');

    for (const name of ['existing.json', 'new.json']) {
      const input = JSON.stringify({ path: join(alias, name) });
      const result = runProtectGeneratedHook(input, physicalRoot);
      expect(result.blocked).toBe(true);
      expect(result.message).toContain(`apps/shared/src/runtime-contract/generated/${name}`);
    }
  });

  it.skipIf(process.platform === 'win32')(
    'protects a lockfile through a symbolic link',
    async () => {
      const physicalRoot = await makeTempDir();
      const alias = join(physicalRoot, 'alias.lock');
      await symlink('bun.lock', alias);

      for (const exists of [false, true]) {
        if (exists) await writeFile(join(physicalRoot, 'bun.lock'), 'lockfile fixture');
        const result = runProtectGeneratedHook(JSON.stringify({ path: alias }), physicalRoot);
        expect(result.blocked).toBe(true);
        expect(result.message).toContain('bun.lock');
      }
    }
  );

  it.skipIf(process.platform === 'win32')('resolves symlinks before parent segments', async () => {
    const physicalRoot = await makeTempDir();
    const generated = join(physicalRoot, 'apps', 'shared', 'src', 'runtime-contract', 'generated');
    const nested = join(generated, 'nested');
    await mkdir(nested, { recursive: true });
    await writeFile(join(generated, 'catalog.json'), '{}');
    await symlink(nested, join(physicalRoot, 'alias'), 'dir');

    for (const path of [`${physicalRoot}/alias/../catalog.json`, 'alias/../catalog.json']) {
      const result = runProtectGeneratedHook(JSON.stringify({ path }), physicalRoot);
      expect(result.blocked).toBe(true);
      expect(result.message).toContain('apps/shared/src/runtime-contract/generated/catalog.json');
    }
  });

  it.skipIf(process.platform === 'win32')('allows literal backslashes in POSIX filenames', () => {
    const filePath = join(root, 'apps\\frontend\\src\\routeTree.gen.ts');
    const result = runProtectGeneratedHook(JSON.stringify({ path: filePath }), root);

    expect(result).toEqual({ blocked: false, message: '' });
  });

  it('allows hand-written files and files outside the repo', () => {
    expect(findProtectedFile(join(root, 'apps', 'api', 'src', 'app.ts'), root)).toBeUndefined();
    expect(findProtectedFile(join(root, 'docs', 'CHANGELOG-notes.md'), root)).toBeUndefined();
    expect(findProtectedFile(join('/workspace', 'other', 'CHANGELOG.md'), root)).toBeUndefined();
  });

  it('blocks a protected edit with the path and the regeneration command', () => {
    const input = JSON.stringify({ tool_input: { file_path: join(root, 'CHANGELOG.md') } });

    const result = runProtectGeneratedHook(input, root);

    expect(result.blocked).toBe(true);
    expect(result.message).toContain('CHANGELOG.md');
    expect(result.message).toContain('bun run changelog');
  });

  it('resolves relative edits from the tool working directory', () => {
    const input = JSON.stringify({
      cwd: join(root, 'packages', 'protocol'),
      tool_input: { file_path: 'CHANGELOG.md' },
    });
    expect(runProtectGeneratedHook(input, root).message).toContain(
      'bun run protocol:release:prepare'
    );
    const outside = JSON.stringify({
      cwd: '/workspace/other',
      tool_input: { file_path: 'CHANGELOG.md' },
    });
    expect(runProtectGeneratedHook(outside, root).blocked).toBe(false);
  });

  it('falls back to the repo root for a repo-relative path from a nested cwd', () => {
    const input = JSON.stringify({
      cwd: join(root, 'packages', 'protocol'),
      tool_input: { file_path: 'packages/protocol/CHANGELOG.md' },
    });

    expect(runProtectGeneratedHook(input, root).message).toContain(
      'bun run protocol:release:prepare'
    );
  });

  it('lets unprotected and unparseable payloads through', () => {
    const input = JSON.stringify({ tool_input: { file_path: join(root, 'README.md') } });

    expect(runProtectGeneratedHook(input, root)).toEqual({ blocked: false, message: '' });
    expect(runProtectGeneratedHook('not json', root)).toEqual({ blocked: false, message: '' });
  });

  it('exits with code 2 and a stderr reason when run as a Claude hook', async () => {
    const proc = Bun.spawn(
      [process.execPath, join(repoRoot, '.claude', 'hooks', 'protect-generated.mjs')],
      { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }
    );
    await proc.stdin.write(
      JSON.stringify({ tool_input: { file_path: join(repoRoot, 'bun.lock') } })
    );
    await proc.stdin.end();

    expect(await proc.exited).toBe(2);
    expect(await new Response(proc.stderr).text()).toContain('bun install');
  });
});
