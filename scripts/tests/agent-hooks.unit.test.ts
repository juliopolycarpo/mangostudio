import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
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
    expect(chooseFormatter('assets/logo.png')).toBeUndefined();
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
