import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  findProtectedFile,
  runProtectGeneratedHook,
} from '../../.claude/hooks/protect-generated.mjs';
import {
  createPathExportLine,
  resolveRepoBin,
  updateClaudeEnvPath,
} from '../../.claude/hooks/session-path.mjs';
import {
  chooseFormatter,
  extractTouchedFilePath,
  isInsideRepo,
  runAutoFixHook,
  shouldSkipFile,
} from '../../.codex/hooks/auto-fix.mjs';

const repoRoot = join(import.meta.dir, '..', '..');
const tempDirs: string[] = [];

async function makeTempDir() {
  const path = await mkdtemp(join(tmpdir(), 'mango-agent-hooks-'));
  tempDirs.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('agent auto-fix hooks', () => {
  it('extracts touched files from Claude and Codex hook payloads', () => {
    const claudeInput = JSON.stringify({ tool_input: { file_path: 'apps/api/src/app.ts' } });
    const codexInput = JSON.stringify({ path: 'README.md' });

    expect(extractTouchedFilePath(claudeInput)).toBe('apps/api/src/app.ts');
    expect(extractTouchedFilePath(codexInput)).toBe('README.md');
    expect(extractTouchedFilePath('not json')).toBe('');
  });

  it('keeps formatting scoped to files inside the repo', () => {
    const root = join('workspace', 'mangostudio');

    expect(isInsideRepo(join(root, 'README.md'), root)).toBe(true);
    expect(isInsideRepo(join('workspace', 'other', 'README.md'), root)).toBe(false);
  });

  it('skips generated and dependency files', () => {
    expect(shouldSkipFile(join('repo', 'node_modules', 'pkg', 'index.ts'))).toBe(true);
    expect(shouldSkipFile(join('repo', 'apps', 'frontend', 'src', 'routeTree.gen.ts'))).toBe(true);
    expect(shouldSkipFile(join('repo', 'apps', 'api', 'src', 'app.ts'))).toBe(false);
  });

  it('chooses the formatter from the touched file name', () => {
    expect(chooseFormatter('src/app.ts')).toBe('biome');
    expect(chooseFormatter('docs/README.md')).toBe('dprint');
    expect(chooseFormatter('Dockerfile.release')).toBe('dprint');
    expect(chooseFormatter('crates/mango-protocol/src/lib.rs')).toBe('rustfmt');
    expect(chooseFormatter('assets/logo.png')).toBeUndefined();
  });

  it.skipIf(!Bun.which('rustfmt'))('formats a touched Rust file with rustfmt', async () => {
    const dir = join(repoRoot, '.mango', `agent-hooks-${process.pid}-${Date.now()}`);
    tempDirs.push(dir);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, 'sample.rs');
    await writeFile(filePath, 'fn  main( ){let x=1;}\n', 'utf8');

    await runAutoFixHook(JSON.stringify({ tool_input: { file_path: filePath } }));

    expect(await readFile(filePath, 'utf8')).toBe('fn main() {\n    let x = 1;\n}\n');
  });

  it('ignores missing touched files without failing the hook', async () => {
    await expect(
      runAutoFixHook(JSON.stringify({ path: 'missing-file.ts' }))
    ).resolves.toBeUndefined();
  });
});

describe('Claude session path hook', () => {
  it('creates a shell export that prepends the repo bin path', () => {
    expect(createPathExportLine('/repo/node_modules/.bin', ':')).toBe(
      'export PATH=\'/repo/node_modules/.bin:\'"$PATH"\n'
    );
  });

  it('resolves the repo-local binary directory', () => {
    expect(resolveRepoBin('/repo')).toBe(join('/repo', 'node_modules', '.bin'));
    expect(resolveRepoBin('')).toBe('');
  });

  it('writes the Claude env file when the repo bin exists', async () => {
    const projectDir = await makeTempDir();
    const envFile = join(projectDir, 'claude-env');
    const repoBin = resolveRepoBin(projectDir);
    await mkdir(repoBin, { recursive: true });
    await writeFile(envFile, '', 'utf8');

    await updateClaudeEnvPath({ CLAUDE_ENV_FILE: envFile, CLAUDE_PROJECT_DIR: projectDir });

    expect(await readFile(envFile, 'utf8')).toBe(createPathExportLine(repoBin, delimiter));
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
    proc.stdin.write(JSON.stringify({ tool_input: { file_path: join(repoRoot, 'bun.lock') } }));
    proc.stdin.end();

    expect(await proc.exited).toBe(2);
    expect(await new Response(proc.stderr).text()).toContain('bun install');
  });
});
