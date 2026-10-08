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
