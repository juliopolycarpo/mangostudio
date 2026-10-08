import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import ts from '@typescript/typescript6';
import { ROOT_DIR } from '../lib/config';
import { assertFrontendApiImportBoundary } from '../lib/frontend-api-import-boundary';

const PARITY_TEST =
  'apps/frontend/tests/unit/features/generation/external-turn-live-vs-reload.test.ts';
const TRANSCRIPT =
  '@mangostudio/api/internal/modules/external-agents/domain/external-turn-transcript';
const tempRoots: string[] = [];

function createSourceTree(path: string, content: string): string {
  const root = mkdtempSync(join(tmpdir(), 'mango-frontend-api-boundary-'));
  tempRoots.push(root);
  writeSource(root, path, content);
  return root;
}

function writeSource(root: string, path: string, content: string): void {
  const absolute = join(root, path.replaceAll('\\', '/'));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function lintSource(path: string, content: string): { exitCode: number; output: string } {
  const root = createSourceTree(path, content);
  const config = JSON.parse(readFileSync(join(ROOT_DIR, 'biome.json'), 'utf8')) as {
    vcs: { enabled: boolean };
  };
  // The isolated fixture has no Git checkout; all rule options and overrides
  // remain the repository's real configuration.
  config.vcs.enabled = false;
  writeFileSync(join(root, 'biome.json'), JSON.stringify(config));
  const result = Bun.spawnSync(
    [
      process.execPath,
      'x',
      '--no-install',
      'biome',
      'lint',
      '--config-path',
      root,
      '--only=style/noRestrictedImports',
      join(root, path),
    ],
    { cwd: ROOT_DIR, stdout: 'pipe', stderr: 'pipe' }
  );
  return { exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop() as string, { recursive: true, force: true });
  }
});

describe('frontend API-internal Biome restriction', () => {
  it.each([
    `import { ExternalTurnTranscript } from '${TRANSCRIPT}';`,
    `import * as transcript from '${TRANSCRIPT}';`,
    `import '${TRANSCRIPT}';`,
    `export { ExternalTurnTranscript } from '${TRANSCRIPT}';`,
    `export * from '${TRANSCRIPT}';`,
    `const transcript = import('${TRANSCRIPT}');`,
    `import transcript = require('${TRANSCRIPT}');`,
  ])('rejects a new frontend value edge: %s', (source) => {
    const result = lintSource('apps/frontend/src/forbidden.ts', source);
    expect(result.exitCode, result.output).toBe(1);
    expect(result.output).toContain('lint/style/noRestrictedImports');
    expect(result.output).toContain(PARITY_TEST);
    expect(result.output).toContain('real hub transcript');
  });

  it.each([
    'apps/frontend/tests/unit/other-parity.test.ts',
    'apps/frontend/src/hooks/use-i18n.tsx',
    'apps/frontend/src/lib/locale-dictionaries.ts',
    'apps/frontend/build.ts',
  ])('keeps the restriction in %s despite locale exemptions', (path) => {
    const result = lintSource(path, `import { ExternalTurnTranscript } from '${TRANSCRIPT}';`);
    expect(result.exitCode, result.output).toBe(1);
    expect(result.output).toContain(PARITY_TEST);
    expect(result.output).toContain('real hub transcript');
  });

  it('allows the unchanged parity test importing the real hub transcript', () => {
    const source = readFileSync(join(ROOT_DIR, PARITY_TEST), 'utf8');
    expect(source).toContain(`from '${TRANSCRIPT}'`);
    expect(source).toContain('new ExternalTurnTranscript(');
    const result = lintSource(PARITY_TEST, source);
    expect(result.exitCode, result.output).toBe(0);
  });

  it('allows the unchanged Eden client root API type import', () => {
    const path = 'apps/frontend/src/lib/api-client.ts';
    const source = readFileSync(join(ROOT_DIR, path), 'utf8');
    expect(source).toContain("import type { App } from '@mangostudio/api';");
    const result = lintSource(path, source);
    expect(result.exitCode, result.output).toBe(0);
  });

  it('allows inline Eden root API types', () => {
    const result = lintSource(
      'apps/frontend/src/eden-types.ts',
      "import { type App } from '@mangostudio/api';"
    );
    expect(result.exitCode, result.output).toBe(0);
  });

  it('does not restrict another workspace importing its own internals', () => {
    const result = lintSource('apps/api/src/own-internal.ts', `import '${TRANSCRIPT}';`);
    expect(result.exitCode, result.output).toBe(0);
  });

  it.each([
    '@mangostudio/shared/i18n',
    '@mangostudio/shared/i18n/en',
    '@mangostudio/shared/i18n/pt-BR',
  ])('preserves the production locale restriction for %s', (specifier) => {
    const result = lintSource('apps/frontend/src/forbidden-locale.ts', `import '${specifier}';`);
    expect(result.exitCode, result.output).toBe(1);
    expect(result.output).toContain('Locale dictionaries are i18n plumbing');
  });

  it.each([
    'apps/frontend/src/hooks/use-i18n.tsx',
    'apps/frontend/src/lib/locale-dictionaries.ts',
    'apps/frontend/tests/unit/locale.test.ts',
  ])('preserves the locale dictionary exemption for %s', (path) => {
    const result = lintSource(path, "import '@mangostudio/shared/i18n/en';");
    expect(result.exitCode, result.output).toBe(0);
  });

  it('preserves the allowed locale plumbing names in production', () => {
    const result = lintSource(
      'apps/frontend/src/locale-types.ts',
      "import { defaultLocale, type Locale, type Messages } from '@mangostudio/shared/i18n';"
    );
    expect(result.exitCode, result.output).toBe(0);
  });
});

describe('frontend API-internal check guard', () => {
  it.each([
    `(require)('${TRANSCRIPT}');`,
    `((require))('${TRANSCRIPT}');`,
    `require!('${TRANSCRIPT}');`,
    `(require as typeof require)('${TRANSCRIPT}');`,
    `(require satisfies typeof require)('${TRANSCRIPT}');`,
    `(<typeof require>require)('${TRANSCRIPT}');`,
    `(module.require)('${TRANSCRIPT}');`,
    `(module.require as typeof require)('${TRANSCRIPT}');`,
    `(module['require'])('${TRANSCRIPT}');`,
    `(module as typeof module).require('${TRANSCRIPT}');`,
    `module!.require('${TRANSCRIPT}');`,
    `(module satisfies typeof module)['require']('${TRANSCRIPT}');`,
    `(<typeof module>module).require('${TRANSCRIPT}');`,
    `module[('require')]('${TRANSCRIPT}');`,
    `module['require' as const]('${TRANSCRIPT}');`,
    `module[('require' satisfies string)]('${TRANSCRIPT}');`,
    `module[(<'require'>'require')]('${TRANSCRIPT}');`,
    `require(('${TRANSCRIPT}'));`,
    `require('${TRANSCRIPT}' as const);`,
    `require(('${TRANSCRIPT}' satisfies string));`,
    `require((<'${TRANSCRIPT}'>'${TRANSCRIPT}'));`,
    `require(('${TRANSCRIPT}')!);`,
    `import(('${TRANSCRIPT}'));`,
    `import(('${TRANSCRIPT}' as const));`,
    `import((\`${TRANSCRIPT}\` satisfies string));`,
    `((require! as typeof require) satisfies typeof require)((('${TRANSCRIPT}' as const)!));`,
  ])('rejects transparent literal loader syntax: %s', (source) => {
    expect(ts.transpileModule(source, { reportDiagnostics: true }).diagnostics ?? []).toEqual([]);
    const root = createSourceTree('apps/frontend/src/forbidden.ts', source);
    expect(() => assertFrontendApiImportBoundary(root)).toThrow(
      'apps/frontend/src/forbidden.ts:1:'
    );
  });

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
