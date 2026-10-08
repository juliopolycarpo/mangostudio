import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import ts from '@typescript/typescript6';
import { ROOT_DIR } from '../lib/config';
import { assertNoSharedRootImports } from '../lib/shared-root-import-boundary';

const SHARED_ROOT = '@mangostudio/shared';
const MESSAGE = 'Use a bounded-context entrypoint';
const tempRoots: string[] = [];

function writeSource(root: string, path: string, source: string): void {
  const absolute = join(root, path.replaceAll('\\', '/'));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, source);
}

function createSourceTree(path: string, source: string): string {
  const root = mkdtempSync(join(tmpdir(), 'mango-shared-root-boundary-'));
  tempRoots.push(root);
  const result = Bun.spawnSync(['git', 'init', '--quiet'], { cwd: root });
  if (!result.success) throw new Error(result.stderr.toString());
  writeSource(root, path, source);
  return root;
}

function lintSource(path: string, source: string): { exitCode: number; output: string } {
  const root = createSourceTree(path, source);
  const config = JSON.parse(readFileSync(join(ROOT_DIR, 'biome.json'), 'utf8')) as {
    vcs: { enabled: boolean };
  };
  // Keep the real rule options and override order while isolating the canary.
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
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('shared root Biome boundary', () => {
  it.each([
    `import { AgentId } from '${SHARED_ROOT}';`,
    `import type { AgentId } from '${SHARED_ROOT}';`,
    `import { type AgentId } from '${SHARED_ROOT}';`,
    `import * as shared from '${SHARED_ROOT}';`,
    `import '${SHARED_ROOT}';`,
    `export { AgentId } from '${SHARED_ROOT}';`,
    `export type { AgentId } from '${SHARED_ROOT}';`,
    `export * from '${SHARED_ROOT}';`,
    `const shared = import('${SHARED_ROOT}');`,
    `const shared = require('${SHARED_ROOT}');`,
    `import shared = require('${SHARED_ROOT}');`,
  ])('rejects a private root edge: %s', (source) => {
    const result = lintSource('apps/api/src/forbidden.ts', source);
    expect(result.exitCode, result.output).toBe(1);
    expect(result.output).toContain('lint/style/noRestrictedImports');
    expect(result.output).toContain(MESSAGE);
    expect(result.output).toContain('type-only imports');
  });

  it.each([
    'apps/api/tests/unit/forbidden.test.ts',
    'apps/frontend/src/forbidden.tsx',
    'apps/frontend/src/hooks/use-i18n.tsx',
    'apps/frontend/src/lib/locale-dictionaries.ts',
    'apps/frontend/tests/unit/forbidden.test.ts',
    'apps/frontend/tests/unit/features/generation/external-turn-live-vs-reload.test.ts',
    'apps/frontend/build.ts',
    'apps/shared/src/forbidden.ts',
    'apps/shared/tests/unit/forbidden.test.ts',
    'packages/protocol/src/forbidden.ts',
    'scripts/forbidden.ts',
    'tests/browser-smoke/forbidden.spec.ts',
    '.codex/hooks/forbidden.mjs',
    'tooling/forbidden.cjs',
  ])('keeps the root denial in %s', (path) => {
    const result = lintSource(path, `import { AgentId } from '${SHARED_ROOT}';`);
    expect(result.exitCode, result.output).toBe(1);
    expect(result.output).toContain(MESSAGE);
  });

  it.each(['@mangostudio/shared/agents', '@mangostudio/shared/contracts'])(
    'allows the retained subpath %s',
    (specifier) => {
      const result = lintSource(
        'apps/api/src/allowed.ts',
        `import type { AgentId } from '${specifier}';`
      );
      expect(result.exitCode, result.output).toBe(0);
    }
  );

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
  ])('preserves the locale dictionary exemption in %s', (path) => {
    const result = lintSource(path, "import '@mangostudio/shared/i18n/en';");
    expect(result.exitCode, result.output).toBe(0);
  });

  it('preserves the allowed locale names and Eden root types', () => {
    const result = lintSource(
      'apps/frontend/src/allowed.ts',
      "import { defaultLocale, type Locale, type Messages } from '@mangostudio/shared/i18n';\nimport type { App } from '@mangostudio/api';"
    );
    expect(result.exitCode, result.output).toBe(0);
  });
});

describe('shared root check guard', () => {
  it.each([
    `(require)('${SHARED_ROOT}');`,
    `((require))('${SHARED_ROOT}');`,
    `require!('${SHARED_ROOT}');`,
    `(require as typeof require)('${SHARED_ROOT}');`,
    `(require satisfies typeof require)('${SHARED_ROOT}');`,
    `(<typeof require>require)('${SHARED_ROOT}');`,
    `(module.require)('${SHARED_ROOT}');`,
    `(module.require as typeof require)('${SHARED_ROOT}');`,
    `(module['require'])('${SHARED_ROOT}');`,
    `(module as typeof module).require('${SHARED_ROOT}');`,
    `module!.require('${SHARED_ROOT}');`,
    `(module satisfies typeof module)['require']('${SHARED_ROOT}');`,
    `(<typeof module>module).require('${SHARED_ROOT}');`,
    `module[('require')]('${SHARED_ROOT}');`,
    `module['require' as const]('${SHARED_ROOT}');`,
    `module[('require' satisfies string)]('${SHARED_ROOT}');`,
    `module[(<'require'>'require')]('${SHARED_ROOT}');`,
    `require(('${SHARED_ROOT}'));`,
    `require('${SHARED_ROOT}' as const);`,
    `require(('${SHARED_ROOT}' satisfies string));`,
    `require((<'${SHARED_ROOT}'>'${SHARED_ROOT}'));`,
    `require(('${SHARED_ROOT}')!);`,
    `import(('${SHARED_ROOT}'));`,
    `import(('${SHARED_ROOT}' as const));`,
    `import((\`${SHARED_ROOT}\` satisfies string));`,
    `((require! as typeof require) satisfies typeof require)((('${SHARED_ROOT}' as const)!));`,
  ])('rejects transparent literal loader syntax: %s', (source) => {
    expect(ts.transpileModule(source, { reportDiagnostics: true }).diagnostics ?? []).toEqual([]);
    const root = createSourceTree('apps/frontend/src/forbidden.ts', source);
    expect(() => assertNoSharedRootImports(root)).toThrow('apps/frontend/src/forbidden.ts:1:');
  });

  it('allows transparent bounded imports and unrelated loader methods', () => {
    const root = createSourceTree(
      'apps/frontend/src/allowed.ts',
      `require(('@mangostudio/shared/agents' as const)); (loader.require as typeof require)('${SHARED_ROOT}');`
    );
    expect(() => assertNoSharedRootImports(root)).not.toThrow();
  });

  it.each([
    `import { AgentId } from '${SHARED_ROOT}';`,
    `import type { AgentId } from '${SHARED_ROOT}';`,
    `import { type AgentId } from '${SHARED_ROOT}';`,
    `import shared from '${SHARED_ROOT}';`,
    `import * as shared from '${SHARED_ROOT}';`,
    `import '${SHARED_ROOT}';`,
    `import {} from '${SHARED_ROOT}';`,
    `export { AgentId } from '${SHARED_ROOT}';`,
    `export type { AgentId } from '${SHARED_ROOT}';`,
    `export * from '${SHARED_ROOT}';`,
    `export type * from '${SHARED_ROOT}';`,
    `export {} from '${SHARED_ROOT}';`,
    `const shared = import('${SHARED_ROOT}');`,
    `const shared = import(\`${SHARED_ROOT}\`);`,
    `const shared = require('${SHARED_ROOT}');`,
    `const shared = module.require('${SHARED_ROOT}');`,
    `const shared = module['require']('${SHARED_ROOT}');`,
    `const shared = module[\`require\`]('${SHARED_ROOT}');`,
    `const shared = module.require(\`${SHARED_ROOT}\`);`,
    `import shared = require('${SHARED_ROOT}');`,
    `import type shared = require('${SHARED_ROOT}');`,
    `type AgentId = import('${SHARED_ROOT}').AgentId;`,
    `type Shared = typeof import('${SHARED_ROOT}');`,
    "import { AgentId } from '@mangostudio/\\u0073hared';",
  ])('rejects the private literal root: %s', (source) => {
    const root = createSourceTree('apps/api/src/forbidden.ts', source);
    expect(() => assertNoSharedRootImports(root)).toThrow('apps/api/src/forbidden.ts:1:');
    expect(() => assertNoSharedRootImports(root)).toThrow(`"${SHARED_ROOT}"`);
    expect(() => assertNoSharedRootImports(root)).toThrow(MESSAGE);
  });

  it.each([
    'apps/api/src/forbidden.ts',
    'apps/frontend/tests/unit/forbidden.test.ts',
    'apps/frontend/src/lib/locale-dictionaries.ts',
    'apps/shared/src/forbidden.ts',
    'packages/protocol/src/forbidden.ts',
    'scripts/forbidden.ts',
    'tests/browser-smoke/forbidden.spec.ts',
    '.claude/hooks/forbidden.mjs',
  ])('inventories tracked and unignored source in %s', (path) => {
    const root = createSourceTree(path, `const shared = module.require('${SHARED_ROOT}');`);
    expect(() => assertNoSharedRootImports(root)).toThrow(path);
  });

  it.each(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts'])(
    'covers the .%s source extension',
    (extension) => {
      const root = createSourceTree(`tooling/forbidden.${extension}`, `import '${SHARED_ROOT}';`);
      expect(() => assertNoSharedRootImports(root)).toThrow(`tooling/forbidden.${extension}`);
    }
  );

  it('normalizes native path separators and reports all import positions', () => {
    const root = createSourceTree(
      'apps\\api\\src\\bad name.ts',
      `import '${SHARED_ROOT}';\nconst shared = require('${SHARED_ROOT}');`
    );
    expect(() => assertNoSharedRootImports(root)).toThrow('apps/api/src/bad name.ts:1:8');
    expect(() => assertNoSharedRootImports(root)).toThrow('apps/api/src/bad name.ts:2:24');
  });

  it('allows bounded subpaths, comments, strings, and unrelated require methods', () => {
    const root = createSourceTree(
      'scripts/allowed.ts',
      `// import '${SHARED_ROOT}';\nconst example = "import '${SHARED_ROOT}';";\nimport type { AgentId } from '@mangostudio/shared/agents';\nexport * from '@mangostudio/shared/contracts';\nconst other = loader.require('${SHARED_ROOT}');`
    );
    expect(() => assertNoSharedRootImports(root)).not.toThrow();
  });

  it('ignores untracked output and dependencies according to Git', () => {
    const root = createSourceTree('scripts/allowed.ts', 'export {};');
    writeSource(root, '.gitignore', 'node_modules/\ndist/\n.mango/\n');
    for (const path of ['node_modules/ignored.js', 'dist/ignored.js', '.mango/ignored.js']) {
      writeSource(root, path, `import '${SHARED_ROOT}';`);
    }
    expect(() => assertNoSharedRootImports(root)).not.toThrow();
  });

  it('still covers ignored paths once they are tracked', () => {
    const root = createSourceTree('scripts/tracked.ts', `import '${SHARED_ROOT}';`);
    writeSource(root, '.gitignore', 'scripts/\n');
    const result = Bun.spawnSync(['git', 'add', '--force', 'scripts/tracked.ts'], { cwd: root });
    expect(result.exitCode).toBe(0);
    expect(() => assertNoSharedRootImports(root)).toThrow('scripts/tracked.ts');
  });

  it('skips a tracked source file deleted from the working tree', () => {
    const root = createSourceTree('scripts/deleted.ts', `import '${SHARED_ROOT}';`);
    const result = Bun.spawnSync(['git', 'add', 'scripts/deleted.ts'], { cwd: root });
    expect(result.exitCode).toBe(0);
    rmSync(join(root, 'scripts/deleted.ts'));
    writeSource(root, 'scripts/allowed.ts', 'export {};');
    expect(() => assertNoSharedRootImports(root)).not.toThrow();
  });

  it('rejects a missing inventory instead of silently passing', () => {
    const root = createSourceTree('README.md', 'fixture');
    expect(() => assertNoSharedRootImports(root)).toThrow('Empty source inventory');
    expect(() => assertNoSharedRootImports(root)).toThrow('expected tracked or unignored');
  });

  it('explains an invalid checkout with its value and expected shape', () => {
    const root = createSourceTree('scripts/allowed.ts', 'export {};');
    rmSync(join(root, '.git'), { recursive: true, force: true });
    expect(() => assertNoSharedRootImports(root)).toThrow(JSON.stringify(root));
    expect(() => assertNoSharedRootImports(root)).toThrow('expected a Git checkout');
  });

  it('explains a missing checkout with its value and expected shape', () => {
    const root = createSourceTree('scripts/allowed.ts', 'export {};');
    rmSync(root, { recursive: true, force: true });
    expect(() => assertNoSharedRootImports(root)).toThrow(JSON.stringify(root));
    expect(() => assertNoSharedRootImports(root)).toThrow('expected a Git checkout');
  });

  it('checks the actual source inventory after the migration', () => {
    const inventory = Bun.spawnSync(
      ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd: ROOT_DIR }
    );
    expect(inventory.exitCode).toBe(0);
    const paths = inventory.stdout
      .toString()
      .split('\0')
      .filter((path) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(path));
    expect(paths.length).toBeGreaterThan(2_500);
    expect(() => assertNoSharedRootImports()).not.toThrow();
  }, 30_000);
});
