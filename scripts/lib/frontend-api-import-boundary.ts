import { readFileSync } from 'node:fs';
import ts from '@typescript/typescript6';

import { ROOT_DIR } from './config';
import { isRequire, unwrapExpression } from './import-specifiers';

const PARITY_TEST =
  'apps/frontend/tests/unit/features/generation/external-turn-live-vs-reload.test.ts';
const API_INTERNAL_PREFIX = '@mangostudio/api/internal/';
const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'coverage', '.turbo', '.mango']);

interface ImportViolation {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly specifier: string;
}

function isTypeOnlyImport(clause: ts.ImportClause | undefined): boolean {
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
    return false;
  }
  return (
    clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every((element) => element.isTypeOnly)
  );
}

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  return (
    node.exportClause !== undefined &&
    ts.isNamedExports(node.exportClause) &&
    node.exportClause.elements.length > 0 &&
    node.exportClause.elements.every((element) => element.isTypeOnly)
  );
}

function findValueImports(source: string, path: string): ImportViolation[] {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false);
  const violations: ImportViolation[] = [];

  function record(node: ts.Node | undefined): void {
    node = unwrapExpression(node);
    if (!node || !ts.isStringLiteralLike(node)) return;
    if (!node.text.startsWith(API_INTERNAL_PREFIX)) return;
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({ path, line: line + 1, column: character + 1, specifier: node.text });
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && !isTypeOnlyImport(node.importClause)) {
      record(node.moduleSpecifier);
    }
    if (ts.isExportDeclaration(node) && !isTypeOnlyExport(node)) {
      record(node.moduleSpecifier);
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      record(node.moduleReference.expression);
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || isRequire(node.expression)) {
        record(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

/**
 * Keep frontend runtime imports out of hub internals, except the test comparing
 * the live reducer with the real hub transcript. Covers deferred imports that
 * Biome's import rule does not recognize and ignores erased type-only imports.
 * Transparent expression wrappers preserve the same literal dependency edge;
 * generated directories are excluded only at the frontend workspace root.
 *
 * @example
 * assertFrontendApiImportBoundary(); // Checks the repository's frontend files.
 */
export function assertFrontendApiImportBoundary(rootDir: string = ROOT_DIR): void {
  const glob = new Bun.Glob('apps/frontend/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}');
  const paths = [...glob.scanSync({ cwd: rootDir, onlyFiles: true, dot: true })]
    .map((path) => path.replaceAll('\\', '/'))
    .filter((path) => !IGNORED_DIRECTORIES.has(path.split('/')[2] ?? ''));
  if (paths.length === 0) {
    throw new Error(
      `Expected frontend JavaScript or TypeScript source files in ${rootDir}/apps/frontend.`
    );
  }
  const violations = paths
    .filter((path) => path !== PARITY_TEST)
    .flatMap((path) => findValueImports(readFileSync(`${rootDir}/${path}`, 'utf8'), path));
  if (violations.length === 0) return;

  const details = violations
    .map(({ path, line, column, specifier }) => `  - ${path}:${line}:${column} (${specifier})`)
    .join('\n');
  throw new Error(
    `Frontend value imports of ${API_INTERNAL_PREFIX}* are allowed only in ${PARITY_TEST} ` +
      'to compare the live reducer with the real hub transcript. Use shared contracts or Eden root API types elsewhere.\n' +
      details
  );
}
