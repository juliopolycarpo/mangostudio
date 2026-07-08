import { dirname, resolve } from 'node:path';
import * as ts from '@typescript/typescript6';

import type { CoverageBucket } from './parse-lcov';

export interface LcovFileCoverage {
  readonly sourcePath: string;
  readonly lineHits: ReadonlyMap<number, number>;
}

interface BranchTotals {
  readonly total: number;
  readonly covered: number;
}

const SHORT_CIRCUIT_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

const bucket = ({ total, covered }: BranchTotals): CoverageBucket => ({
  total,
  covered,
  pct: total === 0 ? 100 : Number(((covered / total) * 100).toFixed(2)),
});

const lineOf = (sourceFile: ts.SourceFile, position: number): number => {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
};

const maxHitsInNode = (
  sourceFile: ts.SourceFile,
  lineHits: ReadonlyMap<number, number>,
  node: ts.Node
): number => {
  const start = lineOf(sourceFile, node.getStart(sourceFile));
  const end = lineOf(sourceFile, node.getEnd());
  let maxHits = 0;
  for (let line = start; line <= end; line++) {
    maxHits = Math.max(maxHits, lineHits.get(line) ?? 0);
  }
  return maxHits;
};

const statementCovered = (
  sourceFile: ts.SourceFile,
  lineHits: ReadonlyMap<number, number>,
  statement: ts.Statement
): boolean => {
  if (ts.isBlock(statement)) {
    return statement.statements.some((child) => maxHitsInNode(sourceFile, lineHits, child) > 0);
  }
  return maxHitsInNode(sourceFile, lineHits, statement) > 0;
};

const maxHitsInStatement = (
  sourceFile: ts.SourceFile,
  lineHits: ReadonlyMap<number, number>,
  statement: ts.Statement
): number => {
  if (ts.isBlock(statement)) {
    return Math.max(
      0,
      ...statement.statements.map((child) => maxHitsInNode(sourceFile, lineHits, child))
    );
  }
  return maxHitsInNode(sourceFile, lineHits, statement);
};

const implicitElseCovered = (
  sourceFile: ts.SourceFile,
  lineHits: ReadonlyMap<number, number>,
  node: ts.IfStatement
): boolean => {
  const conditionLine = lineOf(sourceFile, node.expression.getStart(sourceFile));
  const conditionHits = lineHits.get(conditionLine) ?? 0;
  const thenHits = maxHitsInStatement(sourceFile, lineHits, node.thenStatement);
  return conditionHits > thenHits;
};

const countIfStatement = (
  sourceFile: ts.SourceFile,
  lineHits: ReadonlyMap<number, number>,
  node: ts.IfStatement
): BranchTotals => {
  const thenCovered = statementCovered(sourceFile, lineHits, node.thenStatement);
  const elseCovered = node.elseStatement
    ? statementCovered(sourceFile, lineHits, node.elseStatement)
    : implicitElseCovered(sourceFile, lineHits, node);
  return { total: 2, covered: Number(thenCovered) + Number(elseCovered) };
};

const countConditionalExpression = (
  sourceFile: ts.SourceFile,
  lineHits: ReadonlyMap<number, number>,
  node: ts.ConditionalExpression
): BranchTotals => ({
  total: 2,
  covered:
    Number(maxHitsInNode(sourceFile, lineHits, node.whenTrue) > 0) +
    Number(maxHitsInNode(sourceFile, lineHits, node.whenFalse) > 0),
});

const countSwitchStatement = (
  sourceFile: ts.SourceFile,
  lineHits: ReadonlyMap<number, number>,
  node: ts.SwitchStatement
): BranchTotals => {
  let covered = 0;
  for (const clause of node.caseBlock.clauses) {
    const hit = clause.statements.some(
      (statement) => maxHitsInNode(sourceFile, lineHits, statement) > 0
    );
    const clauseHits = lineHits.get(lineOf(sourceFile, clause.getStart(sourceFile))) ?? 0;
    if (hit || clauseHits > 0) covered++;
  }
  return { total: node.caseBlock.clauses.length, covered };
};

const countShortCircuit = (
  sourceFile: ts.SourceFile,
  lineHits: ReadonlyMap<number, number>,
  node: ts.BinaryExpression
): BranchTotals => {
  const leftLine = lineOf(sourceFile, node.left.getStart(sourceFile));
  const leftHits = lineHits.get(leftLine) ?? 0;
  const rightHits = maxHitsInNode(sourceFile, lineHits, node.right);
  return { total: 2, covered: Number(rightHits > 0) + Number(leftHits > rightHits) };
};

const add = (left: BranchTotals, right: BranchTotals): BranchTotals => ({
  total: left.total + right.total,
  covered: left.covered + right.covered,
});

const countBranches = (
  sourceFile: ts.SourceFile,
  lineHits: ReadonlyMap<number, number>,
  node: ts.Node = sourceFile
): BranchTotals => {
  let totals: BranchTotals = { total: 0, covered: 0 };
  if (ts.isIfStatement(node)) totals = add(totals, countIfStatement(sourceFile, lineHits, node));
  if (ts.isConditionalExpression(node))
    totals = add(totals, countConditionalExpression(sourceFile, lineHits, node));
  if (ts.isSwitchStatement(node))
    totals = add(totals, countSwitchStatement(sourceFile, lineHits, node));
  if (ts.isBinaryExpression(node) && SHORT_CIRCUIT_OPERATORS.has(node.operatorToken.kind)) {
    totals = add(totals, countShortCircuit(sourceFile, lineHits, node));
  }
  node.forEachChild((child) => {
    totals = add(totals, countBranches(sourceFile, lineHits, child));
  });
  return totals;
};

export const parseLcovLineHits = (
  lcovText: string,
  baseDir: string
): readonly LcovFileCoverage[] => {
  const files: LcovFileCoverage[] = [];
  let sourcePath: string | null = null;
  let lineHits = new Map<number, number>();

  const push = (): void => {
    if (sourcePath) files.push({ sourcePath, lineHits });
    sourcePath = null;
    lineHits = new Map<number, number>();
  };

  for (const rawLine of lcovText.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('SF:')) sourcePath = resolve(baseDir, line.slice(3));
    else if (line.startsWith('DA:')) {
      const [lineNumber, hits] = line.slice(3).split(',');
      lineHits.set(Number(lineNumber), Number(hits));
    } else if (line === 'end_of_record') push();
  }
  push();
  return files;
};

export const readSourceBranchCoverageSummary = async (
  lcovPath: string,
  baseDir = dirname(dirname(lcovPath))
): Promise<CoverageBucket> => {
  const lcovText = await Bun.file(lcovPath).text();
  const coverageFiles = parseLcovLineHits(lcovText, baseDir);
  let totals: BranchTotals = { total: 0, covered: 0 };

  for (const { sourcePath, lineHits } of coverageFiles) {
    const file = Bun.file(sourcePath);
    if (!(await file.exists())) continue;
    const sourceText = await file.text();
    const sourceFile = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true);
    totals = add(totals, countBranches(sourceFile, lineHits));
  }

  return bucket(totals);
};
