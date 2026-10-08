import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from '@typescript/typescript6';
import { isRequire, unwrapExpression } from '../lib/import-specifiers';

const REPO_ROOT = resolve(import.meta.dir, '../..');
const API_SRC = join(REPO_ROOT, 'apps/api/src');
const DETECTOR_PATH = 'apps/api/src/lib/file-type-detector.ts';

interface FileTypeImport {
  file: string;
  line: number;
  specifier: string;
}

function findFileTypeImports(source: string, file: string): FileTypeImport[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const imports: FileTypeImport[] = [];

  function recordImport(node: ts.Node | undefined): void {
    node = unwrapExpression(node);
    if (!node || !ts.isStringLiteralLike(node)) return;
    if (node.text !== 'file-type' && !node.text.startsWith('file-type/')) return;
    imports.push({
      file,
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      specifier: node.text,
    });
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      recordImport(node.moduleSpecifier);
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      recordImport(node.moduleReference.expression);
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      recordImport(node.argument.literal);
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || isRequire(node.expression))
    ) {
      recordImport(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return imports;
}

function assertFileTypeBoundary(imports: readonly FileTypeImport[]): void {
  const unexpected = imports.filter((entry) => entry.file !== DETECTOR_PATH);
  if (unexpected.length > 0) {
    const details = unexpected.map(({ file, line, specifier }) => `${file}:${line} (${specifier})`);
    throw new Error(
      `Unexpected file-type importers: ${details.join(', ')}. Expected all API file-type imports in ${DETECTOR_PATH}.`
    );
  }
  if (imports.length === 0) {
    throw new Error(`Expected ${DETECTOR_PATH} to import the retained file-type detector.`);
  }
}

describe('API file-type import boundary', () => {
  const sources = readdirSync(API_SRC, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));

  it('scans the entire API source tree and keeps file-type in its detector', () => {
    expect(sources.length).toBeGreaterThan(50);
    expect(sources).toContain(join(REPO_ROOT, DETECTOR_PATH));
    const imports = sources.flatMap((file) =>
      findFileTypeImports(
        readFileSync(file, 'utf8'),
        relative(REPO_ROOT, file).replaceAll('\\', '/')
      )
    );
    assertFileTypeBoundary(imports);
  });

  it.each([
    "import { fileTypeFromBuffer } from 'file-type';",
    "import 'file-type';",
    "import type { FileTypeResult } from 'file-type';",
    "import { type FileTypeResult } from 'file-type';",
    "export { fileTypeFromBuffer } from 'file-type';",
    "export type { FileTypeResult } from 'file-type';",
    "export * from 'file-type/core';",
    "const detector = await import('file-type');",
    'const detector = await import(`file-type/core`);',
    "const detector = require('file-type');",
    "const detector = require('file-type/core');",
    "const detector = module.require('file-type');",
    "const detector = module['require']('file-type');",
    'const detector = module["require"]("file-type/core");',
    'const detector = module[`require`](`file-type/core`);',
    "import detector = require('file-type');",
    "type Result = import('file-type').FileTypeResult;",
    "import {\n fileTypeFromBuffer\n} from /* comment */ 'file-type/core';",
  ])('recognizes dependency imports in %s', (source) => {
    const imports = findFileTypeImports(source, 'apps/api/src/new-importer.ts');
    expect(imports).toHaveLength(1);
    expect(imports[0].specifier).toMatch(/^file-type(?:\/|$)/);
    expect(() => assertFileTypeBoundary(imports)).toThrow('apps/api/src/new-importer.ts:');
  });

  it.each([
    "const detector = (require)('file-type');",
    "const detector = require!('file-type');",
    "const detector = (require as typeof require)('file-type');",
    "const detector = (require satisfies typeof require)('file-type');",
    "const detector = (<typeof require>require)('file-type');",
    "const detector = (module.require)('file-type');",
    "const detector = module.require!('file-type');",
    "const detector = (module.require as typeof module.require)('file-type');",
    "const detector = (module.require satisfies typeof module.require)('file-type');",
    "const detector = (<typeof module.require>module.require)('file-type');",
    "const detector = (module).require('file-type');",
    "const detector = module!.require('file-type');",
    "const detector = (module as typeof module).require('file-type');",
    "const detector = (module satisfies typeof module).require('file-type');",
    "const detector = (<typeof module>module).require('file-type');",
    "const detector = module[('require')]('file-type');",
    "const detector = module['require'!]('file-type');",
    "const detector = module['require' as const]('file-type');",
    "const detector = module['require' satisfies string]('file-type');",
    "const detector = module[<string>'require']('file-type');",
    "const detector = require(('file-type'));",
    "const detector = module.require('file-type'!);",
    "const detector = require('file-type' as const);",
    "const detector = require('file-type' satisfies string);",
    "const detector = require(<string>'file-type');",
    "const detector = await import(('file-type/core') as string);",
    'const detector = ((module as typeof module)[(`require` satisfies string)]!)(`file-type/core` as const);',
  ])('recognizes transparent loader and literal wrappers in %s', (source) => {
    const parsed = ts.transpileModule(source, { fileName: 'wrapped.ts', reportDiagnostics: true });
    expect(parsed.diagnostics ?? []).toHaveLength(0);
    const imports = findFileTypeImports(source, 'apps/api/src/wrapped.ts');
    expect(imports).toHaveLength(1);
    expect(imports[0].specifier).toMatch(/^file-type(?:\/|$)/);
    expect(() => assertFileTypeBoundary(imports)).toThrow('apps/api/src/wrapped.ts:');
  });

  it.each([
    "// import { fileTypeFromBuffer } from 'file-type';",
    "/* const detector = require('file-type'); */",
    'const example = "import detector from \'file-type\';";',
    "const example = 'file-type';",
    "import { detectFileType } from './file-type-detector';",
    "import detector from 'file-types';",
    "const detector = import('file-type-detector');",
    "const detector = other.require('file-type');",
    "const detector = module.other('file-type');",
    "const detector = module[method]('file-type');",
  ])('ignores comments, strings, and unrelated modules in %s', (source) => {
    expect(findFileTypeImports(source, 'apps/api/src/example.ts')).toEqual([]);
  });

  it('permits the detector and describes an unexpected importer with its source line', () => {
    const allowed = findFileTypeImports("import 'file-type';", DETECTOR_PATH);
    expect(() => assertFileTypeBoundary(allowed)).not.toThrow();
    const unexpected = findFileTypeImports("\nrequire('file-type/core');", 'apps/api/src/other.js');
    expect(() => assertFileTypeBoundary([...allowed, ...unexpected])).toThrow(
      `Unexpected file-type importers: apps/api/src/other.js:2 (file-type/core). Expected all API file-type imports in ${DETECTOR_PATH}.`
    );
  });

  it('fails if the retained detector import disappears', () => {
    expect(() => assertFileTypeBoundary([])).toThrow(
      `Expected ${DETECTOR_PATH} to import the retained file-type detector.`
    );
  });
});
