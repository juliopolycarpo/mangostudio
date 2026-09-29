import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const API_SRC = resolve(import.meta.dir, '../../../src');
const DISPATCH = resolve(API_SRC, 'cli/dispatch.ts');
const RELEASE = resolve(API_SRC, 'services/runtime-client/runtime-connection-release.ts');
const transpiler = new Bun.Transpiler({ loader: 'ts' });

/**
 * Every source file `entry` evaluates at import time: its static (non-type)
 * imports, followed transitively through the API's own relative imports.
 * Embedded non-code assets are skipped. A dynamic `import()` is not
 * followed — that module loads only when the code path that calls it runs.
 */
function staticGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const pending = [entry];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    const imports = transpiler.scanImports(readFileSync(file, 'utf8'));
    for (const { kind, path } of imports) {
      if (kind !== 'import-statement' || !path.startsWith('.')) continue;
      const target = Bun.resolveSync(path, dirname(file));
      // Embedded assets (the installer scripts) are data, not modules.
      if (target.endsWith('.ts') || target.endsWith('.tsx')) pending.push(target);
    }
  }
  return seen;
}

function apiRelative(files: Iterable<string>): string[] {
  return [...files].map((file) => relative(API_SRC, file)).sort();
}

describe('dispatch static import graph', () => {
  const graph = apiRelative(staticGraph(DISPATCH));

  // `mangostudio --version` and `help` must not evaluate every other
  // command's implementation before printing one line.
  test('evaluates no command implementation until a command is selected', () => {
    const commandModules = graph.filter((file) => file.startsWith('cli/commands/'));
    expect(commandModules).toEqual([]);
  });

  // The runtime connection manager drags in the environment repository,
  // every runtime connector and the database. A CLI command that never
  // opened a runtime has nothing for it to release.
  test('does not evaluate the runtime connection manager to release connections', () => {
    const managerModules = graph.filter((file) =>
      file.endsWith('runtime-client/runtime-connection-manager.ts')
    );
    expect(managerModules).toEqual([]);
  });

  // Dispatch reaches the release handle on every command, so the handle must
  // stay dependency-free: an import added to it would pull its graph into
  // `--version` without touching `dispatch.ts`.
  test('the runtime connection release handle imports no other API module', () => {
    expect(apiRelative(staticGraph(RELEASE))).toEqual([
      'services/runtime-client/runtime-connection-release.ts',
    ]);
  });
});
