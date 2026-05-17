import { dirname } from 'node:path';
import * as ts from 'typescript';

import type { CoverageBucket } from './parse-lcov';
import { type LcovFileCoverage, parseLcovLineHits } from './source-branch-coverage';

interface StatementTotals {
  readonly total: number;
  readonly covered: number;
}

const bucket = ({ total, covered }: StatementTotals): CoverageBucket => ({
  total,
  covered,
  pct: total === 0 ? 100 : Number(((covered / total) * 100).toFixed(2)),
});

const lineOf = (sourceFile: ts.SourceFile, position: number): number =>
  sourceFile.getLineAndCharacterOfPosition(position).line + 1;

const maxHitsInNode = (
  sourceFile: ts.SourceFile,
  lineHits: ReadonlyMap<number, number>,
  node: ts.Node
): number => {
  const start = lineOf(sourceFile, node.getStart(sourceFile));
  const end = lineOf(sourceFile, node.getEnd());
  let max = 0;
  for (let line = start; line <= end; line++) {
    max = Math.max(max, lineHits.get(line) ?? 0);
  }
  return max;
};

/**
 * Returns `true` for AST nodes that are purely declarative / type-level and
 * produce no runtime code.  These are excluded from statement counts.
 */
const isNonExecutable = (node: ts.Statement): boolean => {
  if (ts.isInterfaceDeclaration(node)) return true;
  if (ts.isTypeAliasDeclaration(node)) return true;
  if (ts.isImportDeclaration(node)) return true;
  if (ts.isModuleDeclaration(node)) return true;
  if (ts.isEmptyStatement(node)) return true;
  if (ts.isExportDeclaration(node) && node.isTypeOnly) return true;
  if (
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)
  )
    return true;
  return false;
};

/**
 * Walks the full AST and counts every executable `ts.Statement` node that is
 * **not** a bare `Block` (blocks are containers, not independent statements).
 *
 * A statement is "covered" when at least one of the source lines it spans was
 * hit according to the LCOV `DA:` records.
 */
const countStatements = (
  sourceFile: ts.SourceFile,
  lineHits: ReadonlyMap<number, number>
): StatementTotals => {
  let total = 0;
  let covered = 0;

  const walk = (node: ts.Node): void => {
    if (ts.isStatement(node) && !ts.isBlock(node) && !isNonExecutable(node as ts.Statement)) {
      total++;
      if (maxHitsInNode(sourceFile, lineHits, node) > 0) covered++;
    }
    node.forEachChild(walk);
  };

  walk(sourceFile);
  return { total, covered };
};

const add = (left: StatementTotals, right: StatementTotals): StatementTotals => ({
  total: left.total + right.total,
  covered: left.covered + right.covered,
});

export const readSourceStatementCoverageSummary = async (
  lcovPath: string,
  baseDir = dirname(dirname(lcovPath))
): Promise<CoverageBucket> => {
  const lcovText = await Bun.file(lcovPath).text();
  const coverageFiles: readonly LcovFileCoverage[] = parseLcovLineHits(lcovText, baseDir);
  let totals: StatementTotals = { total: 0, covered: 0 };

  for (const { sourcePath, lineHits } of coverageFiles) {
    const file = Bun.file(sourcePath);
    if (!(await file.exists())) continue;
    const sourceText = await file.text();
    const sourceFile = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true);
    totals = add(totals, countStatements(sourceFile, lineHits));
  }

  return bucket(totals);
};
