import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readSourceStatementCoverageSummary } from './source-statement-coverage';

const tempDirs: string[] = [];

interface RepoFixture {
  readonly lcovPath: string;
  readonly workspaceDir: string;
}

// Mirrors the CI layout: LCOV under .mango/artifacts, sources under apps/api.
const makeRepo = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'mango-source-statements-'));
  tempDirs.push(dir);
  await mkdir(join(dir, 'apps/api/src'), { recursive: true });
  await mkdir(join(dir, '.mango/artifacts/coverage/api'), { recursive: true });
  return dir;
};

const writeFixture = async (sourceText: string | null, lcovText: string): Promise<RepoFixture> => {
  const repoDir = await makeRepo();
  const lcovPath = join(repoDir, '.mango/artifacts/coverage/api/lcov.info');
  const writes = [writeFile(lcovPath, lcovText, 'utf8')];
  if (sourceText !== null) {
    writes.push(writeFile(join(repoDir, 'apps/api/src/example.ts'), sourceText, 'utf8'));
  }
  await Promise.all(writes);
  return { lcovPath, workspaceDir: join(repoDir, 'apps/api') };
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('readSourceStatementCoverageSummary', () => {
  it('counts executable statements and skips type-only declarations', async () => {
    const { lcovPath, workspaceDir } = await writeFixture(
      [
        'import { readFile } from "node:fs/promises";',
        'interface Config { readonly name: string; }',
        'type Status = "ok" | "error";',
        'export const NAME = "test";',
        'export function greet(name: string): string {',
        `  return \`Hello, \${name}!\`;`,
        '}',
      ].join('\n'),
      ['SF:src/example.ts', 'DA:4,1', 'DA:5,1', 'DA:6,1', 'end_of_record'].join('\n')
    );

    const summary = await readSourceStatementCoverageSummary(lcovPath, workspaceDir);

    // 3 executable statements: VariableStatement, FunctionDeclaration, ReturnStatement
    // Import, interface, and type alias are skipped
    expect(summary).toEqual({ total: 3, covered: 3, pct: 100 });
  });

  it('counts statements inside compound structures', async () => {
    const { lcovPath, workspaceDir } = await writeFixture(
      [
        'export function process(value: number): string {',
        '  if (value > 0) {',
        '    return "positive";',
        '  } else {',
        '    return "non-positive";',
        '  }',
        '}',
      ].join('\n'),
      ['SF:src/example.ts', 'DA:1,1', 'DA:2,1', 'DA:3,1', 'DA:5,0', 'end_of_record'].join('\n')
    );

    const summary = await readSourceStatementCoverageSummary(lcovPath, workspaceDir);

    // FunctionDeclaration(covered), IfStatement(covered),
    // ReturnStatement "positive"(covered), ReturnStatement "non-positive"(uncovered)
    expect(summary).toEqual({ total: 4, covered: 3, pct: 75 });
  });

  it('counts try-catch block statements individually', async () => {
    const { lcovPath, workspaceDir } = await writeFixture(
      [
        'export function safeParse(input: string): unknown {',
        '  try {',
        '    return JSON.parse(input);',
        '  } catch (err) {',
        '    return null;',
        '  }',
        '}',
      ].join('\n'),
      ['SF:src/example.ts', 'DA:1,1', 'DA:2,1', 'DA:3,1', 'DA:5,0', 'end_of_record'].join('\n')
    );

    const summary = await readSourceStatementCoverageSummary(lcovPath, workspaceDir);

    // FunctionDeclaration(covered), TryStatement(covered),
    // ReturnStatement in try(covered), ReturnStatement in catch(uncovered)
    expect(summary).toEqual({ total: 4, covered: 3, pct: 75 });
  });

  it('reports n/a instead of 100% for an empty source file', async () => {
    const { lcovPath, workspaceDir } = await writeFixture('', 'SF:src/example.ts\nend_of_record\n');

    const summary = await readSourceStatementCoverageSummary(lcovPath, workspaceDir);

    expect(summary).toEqual({ total: 0, covered: 0, pct: null });
  });

  it('reports n/a for an empty LCOV file', async () => {
    const { lcovPath, workspaceDir } = await writeFixture(null, '');

    const summary = await readSourceStatementCoverageSummary(lcovPath, workspaceDir);

    expect(summary).toEqual({ total: 0, covered: 0, pct: null });
  });

  it('fails loudly when a referenced source file does not exist', async () => {
    const { lcovPath, workspaceDir } = await writeFixture(
      null,
      ['SF:src/example.ts', 'DA:1,1', 'end_of_record'].join('\n')
    );

    await expect(readSourceStatementCoverageSummary(lcovPath, workspaceDir)).rejects.toThrow(
      'src/example.ts'
    );
  });
});
