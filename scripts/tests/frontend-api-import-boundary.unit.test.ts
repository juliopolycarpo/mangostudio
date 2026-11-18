import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import ts from '@typescript/typescript6';

import { ROOT_DIR } from '../lib/config';
import { assertFrontendApiImportBoundary } from '../lib/frontend-api-import-boundary';
import {
  createSourceTree,
  removeSourceTrees,
  transparentLoaderForms,
  writeSource,
} from './support/boundary-fixtures';

const PARITY_TEST =
  'apps/frontend/tests/unit/features/generation/external-turn-live-vs-reload.test.ts';
const TRANSCRIPT =
  '@mangostudio/api/internal/modules/external-agents/domain/external-turn-transcript';

/** The message `assertFrontendApiImportBoundary` throws for one fixture source. */
function failureMessage(path: string, source: string): string {
  const root = createSourceTree(path, source);
  try {
    assertFrontendApiImportBoundary(root);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`expected an API-internal failure | received: no failure for ${path}`);
}

afterEach(removeSourceTrees);

describe('frontend API-internal check guard', () => {
  it('names the file, line, import and allowed alternative in its failure', () => {
    expect(failureMessage('apps/frontend/src/forbidden.ts', `\nimport '${TRANSCRIPT}';`)).toBe(
      `Frontend value imports of @mangostudio/api/internal/* are allowed only in ${PARITY_TEST} ` +
        'to compare the live reducer with the real hub transcript. Use shared contracts or Eden root API types elsewhere.\n' +
        `  - apps/frontend/src/forbidden.ts:2:8 (${TRANSCRIPT})`
    );
  });

  it.each(transparentLoaderForms(TRANSCRIPT))(
    'rejects transparent literal loader syntax: %s',
    (source) => {
      expect(ts.transpileModule(source, { reportDiagnostics: true }).diagnostics ?? []).toEqual([]);
      const root = createSourceTree('apps/frontend/src/forbidden.ts', source);
      expect(() => assertFrontendApiImportBoundary(root)).toThrow(
        'apps/frontend/src/forbidden.ts:1:'
      );
    }
  );

  it.each(['dist', 'coverage', 'node_modules', '.turbo', '.mango'])(
    'checks nested frontend source directory %s',
    (directory) => {
      const path = `apps/frontend/src/${directory}/forbidden.ts`;
      const root = createSourceTree(path, `require('${TRANSCRIPT}');`);
      writeSource(root, 'apps/frontend/src/allowed.ts', 'export {};');
      expect(() => assertFrontendApiImportBoundary(root)).toThrow(`${path}:1:`);
    }
  );

  it('allows transparent bounded imports and unrelated loader methods', () => {
    const root = createSourceTree(
      'apps/frontend/src/allowed.ts',
      `require(('@mangostudio/shared/agents' as const)); (loader.require as typeof require)('${TRANSCRIPT}');`
    );
    expect(() => assertFrontendApiImportBoundary(root)).not.toThrow();
  });

  it.each([
    `import { ExternalTurnTranscript } from '${TRANSCRIPT}';`,
    `import transcript from '${TRANSCRIPT}';`,
    `import * as transcript from '${TRANSCRIPT}';`,
    `import '${TRANSCRIPT}';`,
    `import {} from '${TRANSCRIPT}';`,
    `import { type ExternalTurnTranscriptOptions, ExternalTurnTranscript } from '${TRANSCRIPT}';`,
    `export { ExternalTurnTranscript } from '${TRANSCRIPT}';`,
    `export * from '${TRANSCRIPT}';`,
    `export {} from '${TRANSCRIPT}';`,
    `const transcript = import('${TRANSCRIPT}');`,
    `const transcript = import(\`${TRANSCRIPT}\`);`,
    `const transcript = require('${TRANSCRIPT}');`,
    `const transcript = module.require('${TRANSCRIPT}');`,
    `const transcript = module['require']('${TRANSCRIPT}');`,
    `const transcript = module[\`require\`]('${TRANSCRIPT}');`,
    `import transcript = require('${TRANSCRIPT}');`,
    "import { transcript } from '@mangostudio/api/\\u0069nternal/other';",
  ])('rejects an API-internal runtime edge: %s', (source) => {
    const root = createSourceTree('apps/frontend/src/forbidden.ts', source);
    expect(() => assertFrontendApiImportBoundary(root)).toThrow(
      'apps/frontend/src/forbidden.ts:1:'
    );
    expect(() => assertFrontendApiImportBoundary(root)).toThrow(PARITY_TEST);
    expect(() => assertFrontendApiImportBoundary(root)).toThrow('real hub transcript');
  });

  it.each([
    `import type { ExternalTurnTranscript } from '${TRANSCRIPT}';`,
    `import { type ExternalTurnTranscript } from '${TRANSCRIPT}';`,
    `export type { ExternalTurnTranscript } from '${TRANSCRIPT}';`,
    `export { type ExternalTurnTranscript } from '${TRANSCRIPT}';`,
    `export type * from '${TRANSCRIPT}';`,
    `import type transcript = require('${TRANSCRIPT}');`,
    `type Transcript = import('${TRANSCRIPT}').ExternalTurnTranscript;`,
    "import type { App } from '@mangostudio/api';",
    "import { type App } from '@mangostudio/api';",
  ])('ignores erased types in the runtime guard: %s', (source) => {
    const root = createSourceTree('apps/frontend/src/types.ts', source);
    expect(() => assertFrontendApiImportBoundary(root)).not.toThrow();
  });

  it('allows only the exact parity test path and retains useful source positions', () => {
    const root = createSourceTree(PARITY_TEST, `import '${TRANSCRIPT}';`);
    expect(() => assertFrontendApiImportBoundary(root)).not.toThrow();
    writeSource(root, 'apps/frontend/tests/unit/other.test.ts', `\nimport '${TRANSCRIPT}';`);
    expect(() => assertFrontendApiImportBoundary(root)).toThrow(
      `apps/frontend/tests/unit/other.test.ts:2:8 (${TRANSCRIPT})`
    );
  });

  it.each([
    'apps/frontend/tests/unit/other-parity.test.ts',
    'apps/frontend/src/hooks/use-i18n.tsx',
    'apps/frontend/src/lib/locale-dictionaries.ts',
    'apps/frontend/build.ts',
  ])('keeps the restriction in %s despite the locale exemptions', (path) => {
    const root = createSourceTree(path, `import { ExternalTurnTranscript } from '${TRANSCRIPT}';`);
    expect(() => assertFrontendApiImportBoundary(root)).toThrow(`${path}:1:`);
  });

  it('allows the unchanged parity test importing the real hub transcript', () => {
    const source = readFileSync(join(ROOT_DIR, PARITY_TEST), 'utf8');
    expect(source).toContain(`from '${TRANSCRIPT}'`);
    expect(source).toContain('new ExternalTurnTranscript(');
    const root = createSourceTree(PARITY_TEST, source);
    expect(() => assertFrontendApiImportBoundary(root)).not.toThrow();
  });

  it('allows the unchanged Eden client root API type import', () => {
    const path = 'apps/frontend/src/lib/api-client.ts';
    const source = readFileSync(join(ROOT_DIR, path), 'utf8');
    expect(source).toContain("import type { App } from '@mangostudio/api';");
    const root = createSourceTree(path, source);
    expect(() => assertFrontendApiImportBoundary(root)).not.toThrow();
  });

  it('does not restrict another workspace importing its own internals', () => {
    const root = createSourceTree('apps/api/src/own-internal.ts', `import '${TRANSCRIPT}';`);
    writeSource(root, 'apps/frontend/src/allowed.ts', 'export {};');
    expect(() => assertFrontendApiImportBoundary(root)).not.toThrow();
  });

  it.each(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts'])(
    'checks .%s files',
    (extension) => {
      const root = createSourceTree(
        `apps/frontend/build.${extension}`,
        `require('${TRANSCRIPT}');`
      );
      expect(() => assertFrontendApiImportBoundary(root)).toThrow(
        `apps/frontend/build.${extension}:`
      );
    }
  );

  it('ignores comments, illustrative strings, and unrelated packages', () => {
    const root = createSourceTree(
      'apps/frontend/src/unrelated.ts',
      `// import '${TRANSCRIPT}';\n` +
        `/* require('${TRANSCRIPT}'); */\n` +
        `const example = "require('${TRANSCRIPT}')";\n` +
        "import '@mangostudio/shared/external-agents';"
    );
    expect(() => assertFrontendApiImportBoundary(root)).not.toThrow();
  });

  it('accepts native path separators for the exact parity test', () => {
    const root = createSourceTree(PARITY_TEST.replaceAll('/', '\\'), `import '${TRANSCRIPT}';`);
    expect(() => assertFrontendApiImportBoundary(root)).not.toThrow();
  });

  it('ignores dependencies and generated output while still checking frontend sources', () => {
    const root = createSourceTree('apps/frontend/src/valid.ts', 'export const valid = true;');
    for (const directory of ['node_modules', 'dist', 'coverage', '.turbo', '.mango']) {
      writeSource(root, `apps/frontend/${directory}/output.ts`, `require('${TRANSCRIPT}');`);
    }
    expect(() => assertFrontendApiImportBoundary(root)).not.toThrow();
  });

  it('fails descriptively if there are no frontend source files to check', () => {
    const root = createSourceTree('apps/frontend/README.md', '# No sources');
    expect(() => assertFrontendApiImportBoundary(root)).toThrow(
      `Expected frontend JavaScript or TypeScript source files in ${root}/apps/frontend.`
    );
  });

  it('passes against the real frontend source tree with its genuine parity test', () => {
    expect(() => assertFrontendApiImportBoundary()).not.toThrow();
  });
});
