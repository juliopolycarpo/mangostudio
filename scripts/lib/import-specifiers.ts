import ts from '@typescript/typescript6';

/**
 * Strip wrappers that leave the wrapped expression's value untouched, so a
 * module specifier or loader hidden behind them is still recognized.
 *
 * @example
 * unwrapExpression(callExpression.arguments[0]); // ('pkg' as string)! -> 'pkg'
 */
export function unwrapExpression(node: ts.Node | undefined): ts.Node | undefined {
  while (
    node &&
    (ts.isParenthesizedExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isTypeAssertionExpression(node))
  ) {
    node = node.expression;
  }
  return node;
}

/**
 * The text of a string literal behind transparent wrappers, or undefined for
 * anything that is not a literal.
 *
 * @example
 * literalText(importDeclaration.moduleSpecifier) === '@mangostudio/shared';
 */
export function literalText(node: ts.Node | undefined): string | undefined {
  const literal = unwrapExpression(node);
  return literal && ts.isStringLiteralLike(literal) ? literal.text : undefined;
}

/**
 * Whether a call target is `require`, `module.require` or `module['require']`.
 *
 * @example
 * if (ts.isCallExpression(node) && isRequire(node.expression)) record(node.arguments[0]);
 */
export function isRequire(expression: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expression);
  if (!unwrapped) return false;
  if (ts.isIdentifier(unwrapped)) return unwrapped.text === 'require';
  if (!ts.isPropertyAccessExpression(unwrapped) && !ts.isElementAccessExpression(unwrapped)) {
    return false;
  }
  const receiver = unwrapExpression(unwrapped.expression);
  if (!receiver || !ts.isIdentifier(receiver) || receiver.text !== 'module') return false;
  return ts.isPropertyAccessExpression(unwrapped)
    ? unwrapped.name.text === 'require'
    : literalText(unwrapped.argumentExpression) === 'require';
}

/** One literal module dependency edge found in a source file. */
export interface ModuleSpecifier {
  /** Cooked specifier text, so an escape-spelled literal still compares equal. */
  readonly text: string;
  /** 1-based position of the specifier literal. */
  readonly line: number;
  readonly column: number;
  /** Whether the edge is erased at runtime (`import type`, `import('x').T`, ...). */
  readonly typeOnly: boolean;
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

/**
 * Every literal module specifier in `source`: static imports and re-exports,
 * `import x = require()`, `import('x')` types, and `import()`/`require()` calls
 * behind transparent wrappers. Comments, plain strings and computed specifiers
 * are not dependency edges and are left out.
 *
 * @example
 * collectModuleSpecifiers("import 'pkg';", 'a.ts'); // [{ text: 'pkg', line: 1, column: 8, typeOnly: false }]
 */
export function collectModuleSpecifiers(source: string, path: string): ModuleSpecifier[] {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false);
  const specifiers: ModuleSpecifier[] = [];

  function record(node: ts.Node | undefined, typeOnly: boolean): void {
    const literal = unwrapExpression(node);
    if (!literal || !ts.isStringLiteralLike(literal)) return;
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(
      literal.getStart(sourceFile)
    );
    specifiers.push({ text: literal.text, line: line + 1, column: character + 1, typeOnly });
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      record(node.moduleSpecifier, isTypeOnlyImport(node.importClause));
    } else if (ts.isExportDeclaration(node)) {
      record(node.moduleSpecifier, isTypeOnlyExport(node));
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        record(node.moduleReference.expression, node.isTypeOnly);
      }
    } else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument)) record(node.argument.literal, true);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || isRequire(node.expression)) {
        record(node.arguments[0], false);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}
