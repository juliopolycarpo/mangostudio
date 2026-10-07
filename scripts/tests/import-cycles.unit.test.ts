import { describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { protocolCheckTasks } from '../protocol/tasks';
import { countCircularDeps } from '../qa-gate/collect/circular';
import { runCapture } from '../qa-gate/collect/support';
import { readText } from './support/read-text';

const WORKSPACES = ['apps/api', 'apps/frontend', 'apps/shared', 'packages/protocol'];
const VALUE_CYCLE = {
  'a.ts': "import { b } from './b';\n\nexport function a(): number {\n  return b();\n}\n",
  'b.ts': "import { a } from './a';\n\nexport function b(): number {\n  return a();\n}\n",
};
const TYPE_CYCLE = {
  'a.ts': "import type { B } from './b';\n\nexport type A = { b?: B };\n",
  'b.ts': "import type { A } from './a';\n\nexport type B = { a?: A };\n",
};

function createCheckFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'mango-import-cycles-'));
  cpSync(join(ROOT_DIR, 'scripts/lib'), join(root, 'scripts/lib'), { recursive: true });
  writeFileSync(join(root, 'scripts/check.ts'), readText('scripts/check.ts'));
  for (const file of ['package.json', 'bun.lock', 'turbo.jsonc', 'dprint.json']) {
    writeFileSync(join(root, file), readText(file));
  }
  const config = JSON.parse(readText('biome.json'));
  config.vcs.enabled = false;
  config.formatter.enabled = false;
  writeFileSync(join(root, 'biome.json'), JSON.stringify(config));
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  symlinkSync(join(ROOT_DIR, 'node_modules/.bin'), join(root, 'node_modules/.bin'), 'junction');
  symlinkSync(
    join(ROOT_DIR, 'node_modules/@typescript'),
    join(root, 'node_modules/@typescript'),
    'junction'
  );
  symlinkSync(join(ROOT_DIR, 'node_modules/turbo'), join(root, 'node_modules/turbo'), 'junction');
  symlinkSync(
    join(ROOT_DIR, 'node_modules/@dprint'),
    join(root, 'node_modules/@dprint'),
    'junction'
  );
  for (const workspace of WORKSPACES) {
    mkdirSync(join(root, workspace, 'src'), { recursive: true });
    mkdirSync(join(root, workspace, 'tests'), { recursive: true });
    writeFileSync(join(root, workspace, 'src/index.ts'), 'export const leaf = 1;\n');
    const manifest = JSON.parse(readText(`${workspace}/package.json`));
    // Keep the actual lint/check scripts. This named fake isolates typecheck
    // I/O so a missing application fixture never causes the expected failure.
    manifest.scripts.typecheck = 'bun ./fake-typecheck.ts';
    writeFileSync(join(root, workspace, 'fake-typecheck.ts'), 'process.exit(0);\n');
    writeFileSync(join(root, workspace, 'package.json'), JSON.stringify(manifest));
    if (workspace.startsWith('apps/')) {
      for (const file of ['AGENTS.md', 'bunfig.toml']) {
        writeFileSync(join(root, workspace, file), readText(`${workspace}/${file}`));
      }
    }
  }
  return root;
}

function injectCycle(root: string, workspace: string, files: Record<string, string>): void {
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(root, workspace, name), contents);
  }
}

function runCheck(root: string, workspace: string): string {
  const protocolTask = protocolCheckTasks(['--ts-only'], { cargo: false, cargoHack: false })[0];
  const command = workspace.startsWith('apps/')
    ? ['bun', 'run', 'check', `--${workspace.slice(5)}`]
    : ['bunx', ...(protocolTask?.cmd ?? [])];
  const result = Bun.spawnSync(command, { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const output = result.stdout.toString() + result.stderr.toString();
  expect(result.exitCode, output).not.toBe(0);
  return output;
}

describe('Biome import cycle checks', () => {
  for (const workspace of WORKSPACES) {
    for (const [kind, files] of Object.entries({ value: VALUE_CYCLE, type: TYPE_CYCLE })) {
      test(`${workspace} rejects a ${kind} cycle outside src/tests and names both files`, () => {
        const root = createCheckFixture();
        try {
          injectCycle(root, workspace, files);
          const output = runCheck(root, workspace);
          expect(output).toContain('lint/suspicious/noImportCycles');
          expect(output).toContain('a.ts');
          expect(output).toContain('b.ts');
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }

  for (const [kind, files] of Object.entries<Record<string, string>>({
    reexport: {
      'a.ts': "export { b as a } from './b';\n",
      'b.ts': "export { a as b } from './a';\n",
    },
    dynamic: {
      'a.ts': "export const a = () => import('./b');\n",
      'b.ts': "export const b = () => import('./a');\n",
    },
    'named type': {
      'a.ts': "import { type B } from './b';\nexport type A = { b?: B };\n",
      'b.ts': "import { type A } from './a';\nexport type B = { a?: A };\n",
    },
    self: { 'a.ts': "import { a as self } from './a';\nexport const a = () => self();\n" },
    'type self': {
      'a.ts': "import type { A as Self } from './a';\nexport type A = { a?: Self };\n",
    },
  })) {
    test(`counts a ${kind} cycle from actual Biome output`, async () => {
      const root = createCheckFixture();
      try {
        injectCycle(root, 'apps/api', files);
        const runBiome = (cmd: readonly string[]) => runCapture(cmd, { cwd: root });
        expect(await countCircularDeps(['apps/api'], runBiome)).toBe(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test('reports an independent scripts cycle even while all workspace graphs are clean', async () => {
    const root = createCheckFixture();
    try {
      injectCycle(root, 'scripts', VALUE_CYCLE);
      const runBiome = (cmd: readonly string[]) => runCapture(cmd, { cwd: root });
      expect(await countCircularDeps([...WORKSPACES, 'scripts'], runBiome)).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('counts branching cycles through tsconfig aliases', async () => {
    const root = createCheckFixture();
    try {
      writeFileSync(
        join(root, 'apps/api/tsconfig.json'),
        JSON.stringify({
          compilerOptions: { baseUrl: '.', paths: { '@cycle/*': ['./src/*'] } },
        })
      );
      injectCycle(root, 'apps/api/src', {
        'a.ts':
          "import { b } from '@cycle/b'; import { c } from '@cycle/c'; export const a = () => [b(), c()];\n",
        'b.ts': "import { a } from '@cycle/a'; export const b = () => a();\n",
        'c.ts': "import { a } from '@cycle/a'; export const c = () => a();\n",
      });
      const runBiome = (cmd: readonly string[]) => runCapture(cmd, { cwd: root });
      expect(await countCircularDeps(['apps/api'], runBiome)).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps every cycle beyond the default twenty-diagnostic limit', async () => {
    const root = createCheckFixture();
    try {
      for (let index = 0; index < 12; index++) {
        const dir = `apps/api/src/cycle-${index}`;
        mkdirSync(join(root, dir));
        injectCycle(root, dir, TYPE_CYCLE);
      }
      const runBiome = (cmd: readonly string[]) => runCapture(cmd, { cwd: root });
      expect(await countCircularDeps(['apps/api'], runBiome)).toBe(12);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('counts a cycle through package exports across workspace boundaries once', async () => {
    const root = createCheckFixture();
    try {
      const api = JSON.parse(readText('apps/api/package.json'));
      api.exports = { '.': './a.ts' };
      writeFileSync(join(root, 'apps/api/package.json'), JSON.stringify(api));
      mkdirSync(join(root, 'apps/shared/src/library'));
      mkdirSync(join(root, 'node_modules/@mangostudio'));
      for (const name of ['api', 'shared']) {
        symlinkSync(
          join(root, `apps/${name}`),
          join(root, `node_modules/@mangostudio/${name}`),
          'junction'
        );
      }
      injectCycle(root, 'apps/api', {
        'a.ts': "import { b } from '@mangostudio/shared/library'; export const a = () => b();\n",
      });
      injectCycle(root, 'apps/shared/src/library', {
        'index.ts': "import { a } from '@mangostudio/api'; export const b = () => a();\n",
      });
      const runBiome = (cmd: readonly string[]) => runCapture(cmd, { cwd: root });
      expect(await countCircularDeps(['apps/api', 'apps/shared'], runBiome)).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
