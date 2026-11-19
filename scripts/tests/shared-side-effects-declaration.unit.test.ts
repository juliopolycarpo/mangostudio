/**
 * `apps/shared/package.json` tells bundlers which modules run code when they
 * load. A module not listed there is dropped whole when nothing it exports is
 * used, which is what keeps the frontend's first load from carrying every
 * barrel re-export. That is only safe while the list is true, so this test finds
 * the modules that do run something at load and requires the manifest to name
 * exactly those.
 *
 * Variable initializers are not statements the bundler must keep, so
 * `export const Schema = Type.Object(...)` is not a side effect here. A module
 * that needs its load-time call to survive writes it as a top-level statement
 * (`register();`), which is what this scan reports.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import ts from '@typescript/typescript6';

import { WORKSPACES } from '../lib/config';

const SHARED_ROOT = WORKSPACES.shared.path;
const SRC_ROOT = join(SHARED_ROOT, 'src');

/** Top-level statement kinds that only declare; a bundler may drop them with their module. */
const DECLARATION_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.VariableStatement,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.ModuleDeclaration,
  ts.SyntaxKind.ExportDeclaration,
  ts.SyntaxKind.ExportAssignment,
  ts.SyntaxKind.EmptyStatement,
]);

/** What a module runs at load, as `kind at line` strings; empty for a pure module. */
function loadTimeStatements(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true);
  const found: string[] = [];
  for (const statement of file.statements) {
    const isBareImport = ts.isImportDeclaration(statement) && statement.importClause === undefined;
    const isDeclaration =
      (ts.isImportDeclaration(statement) && !isBareImport) || DECLARATION_KINDS.has(statement.kind);
    if (isDeclaration) continue;
    const { line } = file.getLineAndCharacterOfPosition(statement.getStart(file));
    found.push(`${ts.SyntaxKind[statement.kind]} at line ${line + 1}`);
  }
  return found;
}

function sourceFiles(): string[] {
  return readdirSync(SRC_ROOT, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.d.ts'))
    .map((entry) => join(SRC_ROOT, entry))
    .sort();
}

function declaredSideEffects(): string[] {
  const manifest = JSON.parse(readFileSync(join(SHARED_ROOT, 'package.json'), 'utf8')) as {
    sideEffects?: unknown;
  };
  if (!Array.isArray(manifest.sideEffects)) {
    throw new Error(
      `apps/shared/package.json sideEffects: expected an array of file paths | received ${JSON.stringify(manifest.sideEffects)}`
    );
  }
  return manifest.sideEffects.map((entry) => {
    if (typeof entry !== 'string' || !entry.startsWith('./src/')) {
      throw new Error(
        `apps/shared/package.json sideEffects entry: expected a literal "./src/..." file path | received ${JSON.stringify(entry)}`
      );
    }
    return entry;
  });
}

describe('shared package sideEffects declaration', () => {
  it('reports statements that run at load and ignores declarations', () => {
    expect(
      loadTimeStatements(
        'pure.ts',
        `import Type from 'typebox';
         import type { A } from './a';
         export const Schema = Type.Object({});
         export function helper() { return 1; }
         export type B = string;
         export * from './c';`
      )
    ).toEqual([]);
    expect(
      loadTimeStatements(
        'impure.ts',
        `import './polyfill';
         const registry = new Map();
         register(registry);
         if (registry.size) throw new Error('empty');
         globalThis.flag = true;`
      )
    ).toEqual([
      'ImportDeclaration at line 1',
      'ExpressionStatement at line 3',
      'IfStatement at line 4',
      'ExpressionStatement at line 5',
    ]);
  });

  it('names exactly the modules that run code at load', () => {
    const actual = sourceFiles()
      .filter((file) => loadTimeStatements(file, readFileSync(file, 'utf8')).length > 0)
      .map((file) => `./${relative(SHARED_ROOT, file).split(sep).join('/')}`);
    expect(
      actual,
      `apps/shared/package.json sideEffects: expected the modules with load-time statements | received ${JSON.stringify(declaredSideEffects())}`
    ).toEqual([...declaredSideEffects()].sort());
  });

  it('lists only files that exist', () => {
    const present = new Set(
      sourceFiles().map((file) => `./${relative(SHARED_ROOT, file).split(sep).join('/')}`)
    );
    expect(declaredSideEffects().filter((entry) => !present.has(entry))).toEqual([]);
  });
});
