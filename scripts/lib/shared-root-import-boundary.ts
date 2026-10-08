import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from '@typescript/typescript6';
import { ROOT_DIR } from './config';

const SHARED_ROOT = '@mangostudio/shared';
const BOUNDARY_MESSAGE =
  'Use a bounded-context entrypoint such as @mangostudio/shared/agents. The private shared root export was removed; type-only imports must also use a subpath.';
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/;

function literalText(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : undefined;
}

function isRequire(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return expression.text === 'require';
  if (ts.isPropertyAccessExpression(expression)) {
    return (
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === 'module' &&
      expression.name.text === 'require'
    );
  }
  if (!ts.isElementAccessExpression(expression)) return false;
  return (
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'module' &&
    literalText(expression.argumentExpression) === 'require'
  );
}

function rootImportLocations(source: ts.SourceFile): ts.Node[] {
  const locations: ts.Node[] = [];
  const addLiteral = (node: ts.Node | undefined): void => {
    if (literalText(node) === SHARED_ROOT && node) locations.push(node);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addLiteral(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        addLiteral(node.moduleReference.expression);
      }
    } else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument)) addLiteral(node.argument.literal);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || isRequire(node.expression)) {
        addLiteral(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return locations;
}

function sourcePaths(rootDir: string): string[] {
  const checkoutError = `Cannot inventory shared imports in ${JSON.stringify(rootDir)}; expected a Git checkout.`;
  let result: Bun.SyncSubprocess<'pipe', 'pipe'>;
  try {
    result = Bun.spawnSync(
      ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd: rootDir, stdout: 'pipe', stderr: 'pipe' }
    );
  } catch (error) {
    throw new Error(`${checkoutError} ${String(error)}`, { cause: error });
  }
  if (!result.success) {
    throw new Error(`${checkoutError} ${result.stderr.toString().trim()}`);
  }
  const paths = [...new Set(result.stdout.toString().split('\0'))]
    .map((path) => path.replaceAll('\\', '/'))
    .filter((path) => SOURCE_EXTENSION.test(path) && existsSync(join(rootDir, path)));
  if (paths.length === 0) {
    throw new Error(
      `Empty source inventory in ${JSON.stringify(rootDir)}; expected tracked or unignored JavaScript/TypeScript files.`
    );
  }
  return paths;
}

/**
 * Reject private shared root imports throughout the checkout, including erased
 * types and root tooling. Git includes tracked files and unignored new files.
 *
 * @example
 * assertNoSharedRootImports(); // Run before workspace checks.
 */
export function assertNoSharedRootImports(rootDir: string = ROOT_DIR): void {
  const failures: string[] = [];
  for (const path of sourcePaths(rootDir)) {
    const source = ts.createSourceFile(
      path,
      readFileSync(join(rootDir, path), 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    for (const location of rootImportLocations(source)) {
      const { line, character } = source.getLineAndCharacterOfPosition(location.getStart(source));
      failures.push(`${path}:${line + 1}:${character + 1}: ${JSON.stringify(SHARED_ROOT)}`);
    }
  }
  if (failures.length === 0) return;
  throw new Error(
    `Unexpected shared root importer(s):\n${failures.join('\n')}\n${BOUNDARY_MESSAGE}`
  );
}
