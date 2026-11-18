import ts from '@typescript/typescript6';

/**
 * Why this guard exists: a handler that assigns `set.status = 404` and returns
 * a bare `ApiErrorResponse` carries the status in a mutable bag the types never
 * see, so Eden types the error body into the route's successful `data`. The
 * handler returns `status(code, body)` instead, which puts the code in the
 * return type. Nothing at the call site shows the difference, so a new route
 * can bring the bare form back and every caller reads an error as a success.
 *
 * Success codes stay legal: `set.status = 201`, `202`, `204` and `304` describe
 * the body that follows them, not a failure.
 */

/** One `set.status = <error code>` assignment. */
export interface BareErrorStatus {
  readonly file: string;
  /** 1-based line of the assignment. */
  readonly line: number;
  /** Assigned expression text, e.g. `404` or `refusal.status`. */
  readonly assigned: string;
}

function parse(source: string, file: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
}

/** `expression` without wrappers that do not change its value. */
function unwrap(expression: ts.Expression): ts.Expression {
  let node = expression;
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

/** Whether `target` is `set.status`, `context.set.status` or `ctx.set.status`. */
function isSetStatusTarget(target: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(target) || target.name.text !== 'status') return false;
  const owner = unwrap(target.expression);
  if (ts.isIdentifier(owner)) return owner.text === 'set';
  return ts.isPropertyAccessExpression(owner) && owner.name.text === 'set';
}

/**
 * Assignments to the Elysia `set.status` bag that answer a failure.
 *
 * A numeric literal below 400 is a success or redirect and is skipped. Any other
 * right-hand side (`refusal.status`, a variable, a conditional) is reported:
 * the guard cannot prove it is a success code, and a runtime-chosen error code
 * is what `apiErrorStatus` exists for.
 *
 * @example
 * findBareErrorStatuses('set.status = 404;', 'routes.ts'); // [{ file: 'routes.ts', line: 1, assigned: '404' }]
 */
export function findBareErrorStatuses(source: string, file: string): BareErrorStatus[] {
  const sourceFile = parse(source, file);
  const found: BareErrorStatus[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isSetStatusTarget(node.left)
    ) {
      const assigned = unwrap(node.right);
      const isSuccessLiteral = ts.isNumericLiteral(assigned) && Number(assigned.text) < 400;
      if (!isSuccessLiteral) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        found.push({ file, line: line + 1, assigned: assigned.getText(sourceFile) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}
