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
  writeFileSync(
    join(root, 'scripts/check-import-cycles.ts'),
    readText('scripts/check-import-cycles.ts')
  );
  for (const file of [
    'package.json',
    'bun.lock',
    'turbo.jsonc',
    'dprint.json',
    'biome.json',
    'biome.cycles.json',
    '.gitignore',
  ]) {
    writeFileSync(join(root, file), readText(file));
  }
  const git = Bun.spawnSync(['git', 'init', '-q'], { cwd: root, stderr: 'pipe' });
  expect(git.exitCode, git.stderr.toString()).toBe(0);
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  // Windows .bin wrappers resolve package paths relative to node_modules.
  for (const dependency of ['.bin', '@biomejs', '@typescript', '@dprint', 'turbo', 'dprint']) {
    symlinkSync(
      join(ROOT_DIR, `node_modules/${dependency}`),
      join(root, `node_modules/${dependency}`),
      'junction'
    );
  }
  for (const workspace of WORKSPACES) {
    mkdirSync(join(root, workspace, 'src'), { recursive: true });
    mkdirSync(join(root, workspace, 'tests'), { recursive: true });
    writeFileSync(join(root, workspace, 'src/index.ts'), 'export const leaf = 1;\n');
    // Keep the actual lint/check scripts. This named fake isolates typecheck
    // I/O so a missing application fixture never causes the expected failure.
    const manifest = readText(`${workspace}/package.json`).replace(
      '"typecheck": "tsc --noEmit"',
      '"typecheck": "bun ./fake-typecheck.ts"'
    );
    writeFileSync(join(root, workspace, 'fake-typecheck.ts'), 'process.exit(0);\n');
    writeFileSync(join(root, workspace, 'package.json'), manifest);
    if (workspace.startsWith('apps/')) {
      for (const file of ['AGENTS.md', 'bunfig.toml']) {
        writeFileSync(join(root, workspace, file), readText(`${workspace}/${file}`));
      }
    }
  }
  return root;
}

function injectCycle(root: string, workspace: string, files: Record<string, string>): void {
  mkdirSync(join(root, workspace), { recursive: true });
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
    test(`${workspace} rejects and counts a cycle under ignored dist with the actual config`, async () => {
      const root = createCheckFixture();
      try {
        injectCycle(root, `${workspace}/dist`, TYPE_CYCLE);
        const runBiome = (cmd: readonly string[]) => runCapture(cmd, { cwd: root });
        expect(await countCircularDeps([workspace], runBiome)).toBe(1);
        const output = runCheck(root, workspace);
        expect(output).toContain('lint/suspicious/noImportCycles');
        expect(output).toContain('dist/a.ts');
        expect(output).toContain('dist/b.ts');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test('rejects and counts a generated route tree self-import with the actual config', async () => {
    const root = createCheckFixture();
    try {
      injectCycle(root, 'apps/frontend/src', {
        'routeTree.gen.ts':
          "import { routeTree as self } from './routeTree.gen';\nexport const routeTree = () => self();\n",
      });
      const runBiome = (cmd: readonly string[]) => runCapture(cmd, { cwd: root });
      expect(await countCircularDeps(['apps/frontend'], runBiome)).toBe(1);
      const output = runCheck(root, 'apps/frontend');
      expect(output).toContain('lint/nursery/noSelfImport');
      expect(output).toContain('routeTree.gen.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects and counts a generated runtime-contract cycle with the actual config', async () => {
    const root = createCheckFixture();
    try {
      injectCycle(root, 'apps/shared/src/runtime-contract/generated', TYPE_CYCLE);
      const runBiome = (cmd: readonly string[]) => runCapture(cmd, { cwd: root });
      expect(await countCircularDeps(['apps/shared'], runBiome)).toBe(1);
      expect(runCheck(root, 'apps/shared')).toContain('lint/suspicious/noImportCycles');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects and counts TSX cycles excluded only by the actual gitignore', async () => {
    const root = createCheckFixture();
    try {
      injectCycle(root, 'apps/frontend/build', {
        'a.tsx': "import { b } from './b';\nexport const a = () => b();\n",
        'b.tsx': "import { a } from './a';\nexport const b = () => a();\n",
      });
      const runBiome = (cmd: readonly string[]) => runCapture(cmd, { cwd: root });
      expect(await countCircularDeps(['apps/frontend'], runBiome)).toBe(1);
      expect(runCheck(root, 'apps/frontend')).toContain('lint/suspicious/noImportCycles');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects an ignored cycle introduced after a clean required workspace check', () => {
    const root = createCheckFixture();
    try {
      const clean = Bun.spawnSync(['bun', 'run', 'check', '--api'], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(clean.exitCode, clean.stdout.toString() + clean.stderr.toString()).toBe(0);
      injectCycle(root, 'apps/api/dist', TYPE_CYCLE);
      expect(runCheck(root, 'apps/api')).toContain('lint/suspicious/noImportCycles');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects and counts declaration cycles under an ignored directory', async () => {
    const root = createCheckFixture();
    try {
      injectCycle(root, 'packages/protocol/dist', {
        'a.d.ts': TYPE_CYCLE['a.ts'],
        'b.d.ts': TYPE_CYCLE['b.ts'],
      });
      const runBiome = (cmd: readonly string[]) => runCapture(cmd, { cwd: root });
      expect(await countCircularDeps(['packages/protocol'], runBiome)).toBe(1);
      expect(runCheck(root, 'packages/protocol')).toContain('lint/suspicious/noImportCycles');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps TS cycle files larger than the normal Biome one-MiB limit', async () => {
    const root = createCheckFixture();
    try {
      injectCycle(root, 'apps/api/dist', {
        ...TYPE_CYCLE,
        'a.ts': `/*${'x'.repeat(1024 * 1024)}*/\n${TYPE_CYCLE['a.ts']}`,
      });
      const runBiome = (cmd: readonly string[]) => runCapture(cmd, { cwd: root });
      expect(await countCircularDeps(['apps/api'], runBiome)).toBe(1);
      expect(runCheck(root, 'apps/api')).toContain('lint/suspicious/noImportCycles');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps node_modules, git internals and independent JavaScript outside the TS scan', async () => {
    const root = createCheckFixture();
    try {
      injectCycle(root, 'apps/api/node_modules/fixture-dependency', TYPE_CYCLE);
      injectCycle(root, 'apps/api/.git', TYPE_CYCLE);
      injectCycle(root, 'apps/api/dist', {
        'self.js': "import { self } from './self.js';\nexport { self };\n",
      });
      const runBiome = (cmd: readonly string[]) => runCapture(cmd, { cwd: root });
      expect(await countCircularDeps(['apps/api'], runBiome)).toBe(0);
      const clean = Bun.spawnSync(['bun', 'run', 'check', '--api'], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(clean.exitCode, clean.stdout.toString() + clean.stderr.toString()).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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
    CommonJS: {
      'a.ts': "const { b } = require('./b');\nexports.a = () => b();\n",
      'b.ts': "const { a } = require('./a');\nexports.b = () => a();\n",
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

  test('ignores witness-like source comments in actual Biome diagnostics', async () => {
    const root = createCheckFixture();
    try {
      injectCycle(root, 'apps/api', {
        ...VALUE_CYCLE,
        'a.ts':
          "import { b } from './b'; // This import resolves to bogus.ts\n" +
          '// ... which imports spoof.ts\n' +
          '// ... which imports bogus.ts\n' +
          'export const a = () => b();\n',
      });
      const runBiome = (cmd: readonly string[]) => runCapture(cmd, { cwd: root });
      expect(await countCircularDeps(['apps/api'], runBiome)).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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
