import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readSourceStatementCoverageSummary } from './source-statement-coverage';

const tempDirs: string[] = [];

const makeWorkspace = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'mango-source-statements-'));
  tempDirs.push(dir);
  await mkdir(join(dir, 'src'), { recursive: true });
  return dir;
};

const writeFixture = async (
  workspaceDir: string,
  sourceText: string,
  lcovText: string
): Promise<string> => {
  const sourcePath = join(workspaceDir, 'src/example.ts');
  const lcovPath = join(workspaceDir, 'coverage/lcov.info');
  await mkdir(join(workspaceDir, 'coverage'), { recursive: true });
  await Promise.all([
    writeFile(sourcePath, sourceText, 'utf8'),
    writeFile(lcovPath, lcovText, 'utf8'),
  ]);
  return lcovPath;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('readSourceStatementCoverageSummary', () => {
  it('counts executable statements and skips type-only declarations', async () => {
    const workspaceDir = await makeWorkspace();
    const lcovPath = await writeFixture(
      workspaceDir,
      [
        'import { readFile } from "node:fs/promises";',
        'interface Config { readonly name: string; }',
        'type Status = "ok" | "error";',
        'export const NAME = "test";',
        'export function greet(name: string): string {',
        '  return `Hello, ${name}!`;',
        '}',
      ].join('\n'),
      ['SF:src/example.ts', 'DA:4,1', 'DA:5,1', 'DA:6,1', 'end_of_record'].join('\n')
    );

    const summary = await readSourceStatementCoverageSummary(lcovPath);

    // 3 executable statements: VariableStatement, FunctionDeclaration, ReturnStatement
    // Import, interface, and type alias are skipped
    expect(summary).toEqual({ total: 3, covered: 3, pct: 100 });
  });

  it('counts statements inside compound structures', async () => {
    const workspaceDir = await makeWorkspace();
    const lcovPath = await writeFixture(
      workspaceDir,
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

    const summary = await readSourceStatementCoverageSummary(lcovPath);

    // FunctionDeclaration(covered), IfStatement(covered),
    // ReturnStatement "positive"(covered), ReturnStatement "non-positive"(uncovered)
    expect(summary).toEqual({ total: 4, covered: 3, pct: 75 });
  });

  it('counts try-catch block statements individually', async () => {
    const workspaceDir = await makeWorkspace();
    const lcovPath = await writeFixture(
      workspaceDir,
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

    const summary = await readSourceStatementCoverageSummary(lcovPath);

    // FunctionDeclaration(covered), TryStatement(covered),
    // ReturnStatement in try(covered), ReturnStatement in catch(uncovered)
    expect(summary).toEqual({ total: 4, covered: 3, pct: 75 });
  });

  it('returns 100% for an empty source file', async () => {
    const workspaceDir = await makeWorkspace();
    const lcovPath = await writeFixture(workspaceDir, '', 'SF:src/example.ts\nend_of_record\n');

    const summary = await readSourceStatementCoverageSummary(lcovPath);

    expect(summary).toEqual({ total: 0, covered: 0, pct: 100 });
  });
});
