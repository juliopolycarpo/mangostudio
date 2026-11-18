import ts from '@typescript/typescript6';

/**
 * Why this guard exists: spreading an `as const` error-response map into an
 * Elysia route's `response` makes Eden type that route's `error` channel as
 * `unknown`. The same map without `as const` keeps the exact per-status
 * variants. Nothing at the declaration site shows the difference, so a new
 * route module can reintroduce it and every caller falls back to casts.
 */

/** One `...map` inside a `response: { ... }` where `map` is `as const`. */
export interface ConstResponseSpread {
  readonly file: string;
  /** 1-based line of the spread element. */
  readonly line: number;
  /** Spread source text, e.g. `errorResponses` or `{ 401: ... } as const`. */
  readonly spread: string;
}

function parse(source: string, file: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
}

/** Whether `expression` is an object literal asserted `as const`, through parentheses and `satisfies`. */
function isConstAssertedObject(expression: ts.Expression | undefined): boolean {
  let sawConst = false;
  let node: ts.Expression | undefined = expression;
  while (node) {
    if (ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node)) {
      node = node.expression;
    } else if (ts.isAsExpression(node)) {
      if (ts.isConstTypeReference(node.type)) sawConst = true;
      node = node.expression;
    } else {
      break;
    }
  }
  return sawConst && node !== undefined && ts.isObjectLiteralExpression(node);
}

/**
 * Names bound to an `as const` object literal anywhere in the file. A shared
 * map exported from one module and spread in another is found by name, which
 * is why callers collect names across the whole tree before scanning.
 *
 * @example
 * collectConstAssertedObjectNames('const errors = { 401: X } as const;', 'a.ts'); // ['errors']
 */
export function collectConstAssertedObjectNames(source: string, file: string): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      isConstAssertedObject(node.initializer)
    ) {
      names.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(source, file));
  return names;
}

/**
 * Spreads of an `as const` map inside any `response: { ... }` object literal.
 * `constNames` are identifiers known to be `as const` objects; an inline
 * `{ ... } as const` spread is flagged without being named.
 *
 * @example
 * findConstResponseSpreads(source, 'routes.ts', new Set(['errorResponses']));
 */
export function findConstResponseSpreads(
  source: string,
  file: string,
  constNames: ReadonlySet<string>
): ConstResponseSpread[] {
  const sourceFile = parse(source, file);
  const found: ConstResponseSpread[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ((ts.isIdentifier(node.name) && node.name.text === 'response') ||
        (ts.isStringLiteralLike(node.name) && node.name.text === 'response')) &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const property of node.initializer.properties) {
        if (!ts.isSpreadAssignment(property)) continue;
        let target: ts.Expression = property.expression;
        while (ts.isParenthesizedExpression(target) || ts.isNonNullExpression(target)) {
          target = target.expression;
        }
        const named = ts.isIdentifier(target) && constNames.has(target.text);
        if (named || isConstAssertedObject(target)) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(property.getStart(sourceFile));
          found.push({ file, line: line + 1, spread: target.getText(sourceFile) });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}
