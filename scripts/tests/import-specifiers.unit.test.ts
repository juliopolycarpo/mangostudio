import { describe, expect, it } from 'bun:test';
import ts from '@typescript/typescript6';
import {
  collectModuleSpecifiers,
  isRequire,
  literalText,
  unwrapExpression,
} from '../lib/import-specifiers';

/** The first call expression in `source`, which every case below is built around. */
function firstCall(source: string): ts.CallExpression {
  const sourceFile = ts.createSourceFile('case.ts', source, ts.ScriptTarget.Latest, true);
  let found: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error(`Expected a call expression in ${JSON.stringify(source)}.`);
  return found;
}

describe('import specifier helpers', () => {
  it.each([
    "load('pkg')",
    "load(('pkg'))",
    "load('pkg' as string)",
    "load('pkg' satisfies string)",
    "load(<string>'pkg')",
    "load(('pkg' as string)!)",
    'load(`pkg`)',
  ])('reads the literal behind transparent wrappers in %s', (source) => {
    const argument = firstCall(source).arguments[0];
    expect(literalText(argument), source).toBe('pkg');
    expect(unwrapExpression(argument)?.kind, source).not.toBe(
      ts.SyntaxKind.ParenthesizedExpression
    );
  });

  it.each(['load(name)', "load('a' + 'b')", 'load(`pkg/${name}`)', 'load()'])(
    'has no literal text for %s',
    (source) => {
      expect(literalText(firstCall(source).arguments[0]), source).toBeUndefined();
    }
  );

  it.each([
    "require('pkg')",
    "(require)('pkg')",
    "module.require('pkg')",
    "module['require']('pkg')",
    "(module as NodeModule).require('pkg')",
    "(require as NodeRequire)('pkg')",
  ])('recognizes the loader in %s', (source) => {
    expect(isRequire(firstCall(source).expression), source).toBe(true);
  });

  it.each([
    "load('pkg')",
    "other.require('pkg')",
    "module.load('pkg')",
    "module[name]('pkg')",
    "module.require.call(module, 'pkg')",
  ])('does not treat %s as a require call', (source) => {
    expect(isRequire(firstCall(source).expression), source).toBe(false);
  });

  it.each([
    ["import { a } from 'pkg';", false],
    ["import a, { type B } from 'pkg';", false],
    ["import 'pkg';", false],
    ["import {} from 'pkg';", false],
    ["import type { A } from 'pkg';", true],
    ["import { type A, type B } from 'pkg';", true],
    ["export { a } from 'pkg';", false],
    ["export * from 'pkg';", false],
    ["export {} from 'pkg';", false],
    ["export type { A } from 'pkg';", true],
    ["export { type A } from 'pkg';", true],
    ["export type * from 'pkg';", true],
    ["import a = require('pkg');", false],
    ["import type a = require('pkg');", true],
    ["type A = import('pkg').A;", true],
    ["const a = import('pkg');", false],
    ["const a = (module as NodeModule)['require'](('pkg' as const)!);", false],
    ["import { a } from '\\u0070kg';", false],
  ])('collects the dependency edge in %s', (source, typeOnly) => {
    const specifiers = collectModuleSpecifiers(source, 'case.ts');
    expect(
      specifiers.map((specifier) => `${specifier.text} typeOnly=${specifier.typeOnly}`),
      source
    ).toEqual([`pkg typeOnly=${typeOnly}`]);
  });

  it('reports the 1-based position of each specifier literal', () => {
    const specifiers = collectModuleSpecifiers("import 'a';\nconst b = require(('b'));", 'case.ts');
    expect(specifiers.map(({ text, line, column }) => `${text}@${line}:${column}`)).toEqual([
      'a@1:8',
      'b@2:20',
    ]);
  });

  it.each([
    "// import 'pkg';",
    'const example = "import \'pkg\';";',
    'const a = import(name);',
    "const a = other.require('pkg');",
  ])('finds no dependency edge in %s', (source) => {
    expect(collectModuleSpecifiers(source, 'case.ts'), source).toEqual([]);
  });
});
