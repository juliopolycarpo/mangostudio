import * as ts from '@typescript/typescript6';

import type { CoveredSource } from './lcov-sources';
import { type CoverageBucket, coverageBucket } from './parse-lcov';

interface StatementTotals {
  readonly total: number;
  readonly covered: number;
}

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

/** Statement bucket from already-parsed sources, so one `readCoveredSources`
 * pass can feed both this and the branch counter. */
export const sourceStatementCoverageFromSources = (
  sources: readonly CoveredSource[]
): CoverageBucket => {
  let totals: StatementTotals = { total: 0, covered: 0 };

  for (const { sourceFile, lineHits } of sources) {
    totals = add(totals, countStatements(sourceFile, lineHits));
  }

  return coverageBucket(totals.total, totals.covered);
};
