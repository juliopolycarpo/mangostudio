import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { ROOT_DIR } from '../../lib/config';

const tempRoots: string[] = [];

/**
 * Write one fixture source under `root`, creating its directories.
 *
 * @example
 * writeSource(root, 'apps/frontend/src/allowed.ts', 'export {};');
 */
export function writeSource(root: string, path: string, source: string): void {
  const absolute = join(root, path.replaceAll('\\', '/'));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, source);
}

/**
 * Create a temporary source tree holding one file, as a Git checkout when the
 * guard under test inventories through Git.
 *
 * @example
 * const root = createSourceTree('scripts/a.ts', "import 'pkg';", { git: true });
 */
export function createSourceTree(
  path: string,
  source: string,
  options: { git?: boolean } = {}
): string {
  const root = mkdtempSync(join(tmpdir(), 'mango-import-boundary-'));
  tempRoots.push(root);
  if (options.git) {
    const result = Bun.spawnSync(['git', 'init', '--quiet'], { cwd: root });
    if (!result.success) throw new Error(result.stderr.toString());
  }
  writeSource(root, path, source);
  return root;
}

/**
 * Remove every tree `createSourceTree` made.
 *
 * @example
 * afterEach(removeSourceTrees);
 */
export function removeSourceTrees(): void {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
}

/**
 * Lint one fixture file with the repository's restricted-import and syntax options.
 *
 * @example
 * expect(lintSource('apps/frontend/src/a.ts', "import '@mangostudio/shared';").exitCode).toBe(1);
 */
export function lintSource(path: string, source: string): { exitCode: number; output: string } {
  const root = createSourceTree(path, source);
  const config = Bun.TOML.parse(readFileSync(join(ROOT_DIR, 'bunfig.toml'), 'utf8')) as {
    lint: {
      rules: Record<string, unknown>;
      overrides: { files: string[]; excludeFiles?: string[]; rules: Record<string, unknown> }[];
    };
  };
  const onlyBoundary = (rules: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(rules).filter(([rule]) =>
        ['no-restricted-imports', 'no-restricted-syntax'].includes(rule)
      )
    );
  const blocks = [
    { files: ['**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}'], rules: onlyBoundary(config.lint.rules) },
    ...config.lint.overrides.map(({ files, excludeFiles, rules }) => ({
      files,
      ...(excludeFiles ? { ignores: excludeFiles } : {}),
      rules: onlyBoundary(rules),
    })),
  ];
  writeFileSync(join(root, 'eslint.config.mjs'), `export default ${JSON.stringify(blocks)};\n`);
  const result = Bun.spawnSync([process.execPath, 'lint', '--no-script', path], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

/** Lint a fixture with the full repository Bun configuration.
 * @example lintConfiguredSource('src/a.ts', "import '@mangostudio/shared';");
 */
export function lintConfiguredSource(
  path: string,
  source: string
): { exitCode: number; output: string } {
  const root = createSourceTree(path, source);
  writeFileSync(join(root, 'bunfig.toml'), readFileSync(join(ROOT_DIR, 'bunfig.toml')));
  const result = Bun.spawnSync([process.execPath, 'lint', '--no-script', path], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

/**
 * Loader calls that hide `specifier` or the loader behind wrappers TypeScript
 * erases, so each still names the same literal module dependency.
 *
 * @example
 * it.each(transparentLoaderForms('pkg'))('rejects %s', (source) => { ... });
 */
export function transparentLoaderForms(specifier: string): string[] {
  return [
    `(require)('${specifier}');`,
    `((require))('${specifier}');`,
    `require!('${specifier}');`,
    `(require as typeof require)('${specifier}');`,
    `(require satisfies typeof require)('${specifier}');`,
    `(<typeof require>require)('${specifier}');`,
    `(module.require)('${specifier}');`,
    `(module.require as typeof require)('${specifier}');`,
    `(module['require'])('${specifier}');`,
    `(module as typeof module).require('${specifier}');`,
    `module!.require('${specifier}');`,
    `(module satisfies typeof module)['require']('${specifier}');`,
    `(<typeof module>module).require('${specifier}');`,
    `module[('require')]('${specifier}');`,
    `module['require' as const]('${specifier}');`,
    `module[('require' satisfies string)]('${specifier}');`,
    `module[(<'require'>'require')]('${specifier}');`,
    `require(('${specifier}'));`,
    `require('${specifier}' as const);`,
    `require(('${specifier}' satisfies string));`,
    `require((<'${specifier}'>'${specifier}'));`,
    `require(('${specifier}')!);`,
    `import(('${specifier}'));`,
    `import(('${specifier}' as const));`,
    `import((\`${specifier}\` satisfies string));`,
    `((require! as typeof require) satisfies typeof require)((('${specifier}' as const)!));`,
  ];
}
