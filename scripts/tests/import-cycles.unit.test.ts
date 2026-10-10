import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { protocolCheckTasks } from '../protocol/tasks';
import { countCircularDeps } from '../qa-gate/collect/circular';
import { runCapture } from '../qa-gate/collect/support';
import { canonicalPath } from './support/canonical-path';
import { readText } from './support/read-text';

const WORKSPACES = ['apps/api', 'apps/frontend', 'apps/shared', 'packages/protocol'];
const NO_IMPORT_CYCLES = 'lint/suspicious/noImportCycles';
const NO_SELF_IMPORT = 'lint/nursery/noSelfImport';
const DEPENDENCY_LINKS = [
  '.bin',
  '@biomejs',
  '@typescript',
  '@dprint',
  'turbo',
  'dprint',
  'typescript',
];
const VALUE_CYCLE = {
  'a.ts': "import { b } from './b';\n\nexport function a(): number {\n  return b();\n}\n",
  'b.ts': "import { a } from './a';\n\nexport function b(): number {\n  return a();\n}\n",
};
const TYPE_CYCLE = {
  'a.ts': "import type { B } from './b';\n\nexport type A = { b?: B };\n",
  'b.ts': "import type { A } from './a';\n\nexport type B = { a?: A };\n",
};

/**
 * One cycle injected into a fixture. Several cases share a fixture and a scan,
 * so every failure message names its case.
 * @example
 * { name: 'dist type cycle', dir: 'dist', files: TYPE_CYCLE, rule: NO_IMPORT_CYCLES }
 */
interface CycleCase {
  readonly name: string;
  /** Workspace-relative directory the files are written to; unique per case. */
  readonly dir: string;
  readonly files: Readonly<Record<string, string>>;
  /** The rule Biome must report on one of the case's files. */
  readonly rule: string;
}

interface CheckRun {
  readonly exitCode: number;
  readonly output: string;
}

let baseFixture = '';
const fixtures: string[] = [];

/**
 * Everything a workspace check reads except `node_modules`, written once per
 * file. Nothing runs inside it; `createFixture` hands out copies.
 */
function buildBaseFixture(): string {
  const root = canonicalPath(mkdtempSync(join(tmpdir(), 'mango-import-cycles-base-')));
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
  expect(
    git.exitCode,
    `git init in ${root}: expected exit 0 | received ${git.exitCode}: ${git.stderr.toString()}`
  ).toBe(0);
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

function linkDependencies(root: string): void {
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  // Windows .bin wrappers resolve package paths relative to node_modules.
  // Scoped package links in Bun's isolated layout also need their sibling store.
  const dependencies = existsSync(join(ROOT_DIR, 'node_modules/.bun'))
    ? [...DEPENDENCY_LINKS, '.bun']
    : DEPENDENCY_LINKS;
  for (const dependency of dependencies) {
    symlinkSync(
      join(ROOT_DIR, `node_modules/${dependency}`),
      join(root, `node_modules/${dependency}`),
      'junction'
    );
  }
}

/**
 * An isolated copy of the base fixture with its dependencies linked, removed by
 * the next `afterEach` (a batch hook's copy goes after the batch's first test,
 * which is harmless because a scan keeps only plain output). The links are made
 * per copy because a copied junction is not portable.
 * @example
 * const root = createFixture();
 */
function createFixture(parent: string = tmpdir()): string {
  if (!baseFixture) {
    throw new Error(
      `createFixture() ran before the base fixture existed | received baseFixture ${JSON.stringify(baseFixture)}, expected the directory built by this file's beforeAll`
    );
  }
  const root = canonicalPath(mkdtempSync(join(parent, 'mango-import-cycles-')));
  fixtures.push(root);
  cpSync(baseFixture, root, { recursive: true });
  linkDependencies(root);
  return root;
}

function removeFixtures(): void {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
}

function injectCycle(root: string, dir: string, files: Readonly<Record<string, string>>): void {
  mkdirSync(join(root, dir), { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(root, dir, name), contents);
  }
}

function injectCases(root: string, workspace: string, cases: readonly CycleCase[]): void {
  for (const { dir, files } of cases) injectCycle(root, join(workspace, dir), files);
}

function runCheck(root: string, workspace: string): CheckRun {
  const protocolTask = protocolCheckTasks(['--ts-only'], { cargo: false, cargoHack: false })[0];
  const command = workspace.startsWith('apps/')
    ? ['bun', 'run', 'check', `--${workspace.slice(5)}`]
    : ['bunx', ...(protocolTask?.cmd ?? [])];
  const result = Bun.spawnSync(command, { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  return { exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

/**
 * Count cycles the way the QA gate does and keep every Biome output the count
 * was built from, so a batch can check which of its cases Biome named.
 * @example
 * const { circularDeps } = await scanCycles(root, ['apps/api']);
 */
async function scanCycles(
  root: string,
  roots: readonly string[]
): Promise<{ circularDeps: number; output: string }> {
  const outputs: string[] = [];
  const circularDeps = await countCircularDeps(roots, async (cmd) => {
    const result = await runCapture(cmd, { cwd: root });
    outputs.push(result.stdout + result.stderr);
    return result;
  });
  return { circularDeps, output: outputs.join('\n') };
}

async function countCycles(root: string, roots: readonly string[]): Promise<number> {
  return (await scanCycles(root, roots)).circularDeps;
}

function expectCycleCount(actual: number, expected: number, context: string): void {
  expect(
    actual,
    `${context}: expected ${expected} circular dependencies | received ${actual}`
  ).toBe(expected);
}

function expectCheck(run: CheckRun, outcome: 'pass' | 'fail', context: string): void {
  expect(
    run.exitCode === 0,
    `${context}: expected the check to ${outcome} | received exit ${run.exitCode}\n${run.output}`
  ).toBe(outcome === 'pass');
}

const posix = (text: string): string => text.replaceAll('\\', '/');

/** Whole path segments only, so `self/a.ts` never matches `type-self/a.ts`. */
const isFile = (path: string, file: string): boolean => `/${path}`.endsWith(`/${file}`);

/** Biome diagnostic headers, `<path>:<line>:<column> <rule>`, from a check or lint output. */
function diagnosticHeaders(output: string): Array<{ file: string; rule: string }> {
  return [...posix(output).matchAll(/(\S+):\d+:\d+ (lint\/\S+)/g)].map(([, file, rule]) => ({
    file,
    rule,
  }));
}

/**
 * Assert Biome flagged this case with its rule and named every one of its files.
 * Scoped to the case's own files so another case's diagnostics cannot satisfy it.
 * @example
 * expectCaseReported(run.output, IGNORED_CASES['apps/api'][0]);
 */
function expectCaseReported(output: string, { name, dir, files, rule }: CycleCase): void {
  const caseFiles = Object.keys(files).map((file) => `${dir}/${file}`);
  const headers = diagnosticHeaders(output);
  const reported = headers.filter((header) => caseFiles.some((file) => isFile(header.file, file)));
  const received = JSON.stringify(headers.map((header) => `${header.file} ${header.rule}`));
  expect(
    reported.map((header) => header.rule),
    `${name}: expected ${rule} reported on one of ${caseFiles.join(', ')} | received ${received}`
  ).toContain(rule);
  const mentioned = posix(output).split(/[\s:'",]+/);
  for (const file of caseFiles) {
    expect(
      mentioned.some((token) => isFile(token, file)),
      `${name}: expected the output to name ${file} | received ${received}`
    ).toBe(true);
  }
}

/**
 * Register one describe whose hook scans all cases once. A test per case checks
 * its own slice of that scan and `assertWhole` checks what only the whole scan
 * can say (exit code, cycle count). The scan is read-only after the hook, so the
 * tests are order-insensitive.
 * @example
 * defineBatch('apps/api rejects', cases, () => scanVisible('apps/api', cases), assertFails);
 */
function defineBatch<Scan extends { readonly output: string }>(
  title: string,
  cases: readonly CycleCase[],
  scan: () => Scan | Promise<Scan>,
  assertWhole: (scan: Scan) => void
): void {
  describe(title, () => {
    let result: Scan;
    beforeAll(async () => {
      result = await scan();
    });
    test(`rejects all ${cases.length} cases together`, () => assertWhole(result));
    for (const batchCase of cases) {
      test(`rejects the ${batchCase.name} and names its files`, () => {
        expectCaseReported(result.output, batchCase);
      });
    }
  });
}

// Cycles under paths Biome's own config ignores. Only the dedicated cycle scan sees
// them, and `biome check .` must stay clean or it short-circuits that scan.
const IGNORED_CASES: Record<string, CycleCase[]> = {
  'apps/api': [
    { name: 'dist type cycle', dir: 'dist', files: TYPE_CYCLE, rule: NO_IMPORT_CYCLES },
    {
      name: 'dist TS cycle larger than the normal Biome one-MiB limit',
      dir: 'dist/oversized',
      files: { ...TYPE_CYCLE, 'a.ts': `/*${'x'.repeat(1024 * 1024)}*/\n${TYPE_CYCLE['a.ts']}` },
      rule: NO_IMPORT_CYCLES,
    },
    {
      name: 'independent JavaScript cycle without a TS importer',
      dir: 'dist/independent-js',
      files: {
        'self.js':
          "import { self as again } from './self.js';\nexport const self = () => again();\n",
      },
      rule: NO_SELF_IMPORT,
    },
  ],
  'apps/frontend': [
    { name: 'dist type cycle', dir: 'dist', files: TYPE_CYCLE, rule: NO_IMPORT_CYCLES },
    {
      name: 'generated route tree self-import',
      dir: 'src',
      files: {
        'routeTree.gen.ts':
          "import { routeTree as self } from './routeTree.gen';\nexport const routeTree = () => self();\n",
      },
      rule: NO_SELF_IMPORT,
    },
    {
      name: 'TSX cycle excluded only by the gitignore',
      dir: 'build',
      files: {
        'a.tsx': "import { b } from './b';\nexport const a = () => b();\n",
        'b.tsx': "import { a } from './a';\nexport const b = () => a();\n",
      },
      rule: NO_IMPORT_CYCLES,
    },
  ],
  'apps/shared': [
    { name: 'dist type cycle', dir: 'dist', files: TYPE_CYCLE, rule: NO_IMPORT_CYCLES },
    {
      name: 'generated runtime-contract cycle',
      dir: 'src/runtime-contract/generated',
      files: TYPE_CYCLE,
      rule: NO_IMPORT_CYCLES,
    },
  ],
  'packages/protocol': [
    { name: 'dist type cycle', dir: 'dist', files: TYPE_CYCLE, rule: NO_IMPORT_CYCLES },
    {
      name: 'declaration cycle',
      dir: 'dist/declarations',
      files: { 'a.d.ts': TYPE_CYCLE['a.ts'], 'b.d.ts': TYPE_CYCLE['b.ts'] },
      rule: NO_IMPORT_CYCLES,
    },
  ],
};

// Cycles outside src and tests that normal lint scope still covers.
const VISIBLE_CASES: CycleCase[] = [
  { name: 'value cycle', dir: 'value-cycle', files: VALUE_CYCLE, rule: NO_IMPORT_CYCLES },
  { name: 'type cycle', dir: 'type-cycle', files: TYPE_CYCLE, rule: NO_IMPORT_CYCLES },
];

// Count-only kinds: each is one cycle in its own directory of apps/api.
const KIND_CASES: CycleCase[] = [
  {
    name: 're-export cycle',
    dir: 'reexport',
    files: {
      'a.ts': "export { b as a } from './b';\n",
      'b.ts': "export { a as b } from './a';\n",
    },
    rule: NO_IMPORT_CYCLES,
  },
  {
    name: 'dynamic cycle',
    dir: 'dynamic',
    files: {
      'a.ts': "export const a = () => import('./b');\n",
      'b.ts': "export const b = () => import('./a');\n",
    },
    rule: NO_IMPORT_CYCLES,
  },
  {
    name: 'CommonJS cycle',
    dir: 'commonjs',
    files: {
      'a.ts': "const { b } = require('./b');\nexports.a = () => b();\n",
      'b.ts': "const { a } = require('./a');\nexports.b = () => a();\n",
    },
    rule: NO_IMPORT_CYCLES,
  },
  {
    name: 'named type cycle',
    dir: 'named-type',
    files: {
      'a.ts': "import { type B } from './b';\nexport type A = { b?: B };\n",
      'b.ts': "import { type A } from './a';\nexport type B = { a?: A };\n",
    },
    rule: NO_IMPORT_CYCLES,
  },
  {
    name: 'self cycle',
    dir: 'self',
    files: { 'a.ts': "import { a as self } from './a';\nexport const a = () => self();\n" },
    rule: NO_SELF_IMPORT,
  },
  {
    name: 'type self cycle',
    dir: 'type-self',
    files: { 'a.ts': "import type { A as Self } from './a';\nexport type A = { a?: Self };\n" },
    rule: NO_SELF_IMPORT,
  },
];

/** The JS-family cycle for one extension and kind; `cjs` uses `require`. */
function scriptCycleFiles(extension: string, kind: 'pair' | 'self'): Record<string, string> {
  const first = `a.${extension}`;
  const second = `b.${extension}`;
  if (extension === 'cjs') {
    return kind === 'self'
      ? { [first]: `const { a: again } = require('./${first}');\nexports.a = () => again();\n` }
      : {
          [first]: `const { b } = require('./${second}');\nexports.a = () => b();\n`,
          [second]: `const { a } = require('./${first}');\nexports.b = () => a();\n`,
        };
  }
  const returnType = extension === 'mts' || extension === 'cts' ? ': number' : '';
  return kind === 'self'
    ? {
        [first]: `import { a as again } from './${first}';\nexport const a = ()${returnType} => again();\n`,
      }
    : {
        [first]: `import { b } from './${second}';\nexport const a = ()${returnType} => b();\n`,
        [second]: `import { a } from './${first}';\nexport const b = ()${returnType} => a();\n`,
      };
}

// Every extension x kind pair gets its own dist directory and TS entry file.
const EXTENSION_CASES: CycleCase[] = ['js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'].flatMap(
  (extension) =>
    (['pair', 'self'] as const).map((kind) => ({
      name: `TS-imported ${extension} ${kind} cycle`,
      dir: `dist/${kind}-${extension}`,
      files: scriptCycleFiles(extension, kind),
      rule: kind === 'self' ? NO_SELF_IMPORT : NO_IMPORT_CYCLES,
    }))
);

const FRONTEND_TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      allowImportingTsExtensions: true,
      jsx: 'preserve',
      noEmit: true,
      strict: true,
      types: [],
    },
    include: ['src/**/*.ts'],
  },
  null,
  2
)}\n`;

/**
 * Typecheck, required check and cycle count over one frontend fixture holding
 * every extension case, each imported from its own TS entry under `src`.
 */
async function scanExtensionCases(cases: readonly CycleCase[]) {
  const root = createFixture();
  injectCases(root, 'apps/frontend', cases);
  for (const { dir, files } of cases) {
    injectCycle(root, 'apps/frontend/src', {
      [`entry-${basename(dir)}.ts`]: `import '../${dir}/${Object.keys(files)[0]}';\n\nexport const value = 1;\n`,
    });
  }
  writeFileSync(join(root, 'apps/frontend/package.json'), readText('apps/frontend/package.json'));
  writeFileSync(join(root, 'apps/frontend/tsconfig.json'), FRONTEND_TSCONFIG);
  const formatConfig = Bun.spawnSync(
    ['bunx', 'biome', 'format', '--write', 'apps/frontend/tsconfig.json'],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' }
  );
  expect(
    formatConfig.exitCode,
    `biome format of apps/frontend/tsconfig.json: expected exit 0 | received ${formatConfig.exitCode}: ${formatConfig.stderr.toString()}`
  ).toBe(0);
  const typecheck = Bun.spawnSync(['bun', 'run', 'typecheck'], {
    cwd: join(root, 'apps/frontend'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const required = runCheck(root, 'apps/frontend');
  const counted = await scanCycles(root, ['apps/frontend']);
  return {
    typecheck: { exitCode: typecheck.exitCode, output: typecheck.stderr.toString() },
    required,
    circularDeps: counted.circularDeps,
    output: required.output,
  };
}

/** Count and run the required check over a workspace holding every case. */
async function scanIgnored(workspace: string, cases: readonly CycleCase[]) {
  const root = createFixture();
  injectCases(root, workspace, cases);
  const counted = await scanCycles(root, [workspace]);
  const run = runCheck(root, workspace);
  return { ...run, circularDeps: counted.circularDeps };
}

function scanVisible(workspace: string, cases: readonly CycleCase[]): CheckRun {
  const root = createFixture();
  injectCases(root, workspace, cases);
  return runCheck(root, workspace);
}

function scanKinds(cases: readonly CycleCase[]) {
  const root = createFixture();
  injectCases(root, 'apps/api', cases);
  return scanCycles(root, ['apps/api']);
}

beforeAll(() => {
  baseFixture = buildBaseFixture();
});

afterEach(removeFixtures);

afterAll(() => {
  removeFixtures();
  rmSync(baseFixture, { recursive: true, force: true });
});

describe('Biome import cycle checks', () => {
  defineBatch(
    'TS-imported JS-family cycles with real typechecking',
    EXTENSION_CASES,
    () => scanExtensionCases(EXTENSION_CASES),
    (scan) => {
      const names = EXTENSION_CASES.map(({ name }) => name).join(', ');
      expect(
        {
          typecheck: scan.typecheck.exitCode,
          required: scan.required.exitCode,
          circularDeps: scan.circularDeps,
        },
        `expected typecheck 0, required check 1 and ${EXTENSION_CASES.length} cycles (${names}) | tsc stderr and check output:\n${scan.typecheck.output}${scan.output}`
      ).toEqual({ typecheck: 0, required: 1, circularDeps: EXTENSION_CASES.length });
    }
  );

  for (const [workspace, cases] of Object.entries(IGNORED_CASES)) {
    defineBatch(
      `${workspace} cycles under paths ignored by the actual config`,
      cases,
      () => scanIgnored(workspace, cases),
      (scan) => {
        expectCheck(scan, 'fail', `${workspace} with ${cases.length} ignored cycles`);
        expectCycleCount(scan.circularDeps, cases.length, `${workspace} ignored cycles`);
      }
    );
  }

  for (const workspace of WORKSPACES) {
    defineBatch(
      `${workspace} cycles outside src and tests`,
      VISIBLE_CASES,
      () => scanVisible(workspace, VISIBLE_CASES),
      (scan) => expectCheck(scan, 'fail', `${workspace} with ${VISIBLE_CASES.length} cycles`)
    );
  }

  defineBatch(
    'apps/api cycle kinds counted from actual Biome output',
    KIND_CASES,
    () => scanKinds(KIND_CASES),
    (scan) => expectCycleCount(scan.circularDeps, KIND_CASES.length, 'apps/api cycle kinds')
  );

  test('rejects an ignored cycle introduced after a clean required workspace check', () => {
    const root = createFixture();
    expectCheck(runCheck(root, 'apps/api'), 'pass', 'apps/api before injecting a cycle');
    injectCycle(root, 'apps/api/dist', TYPE_CYCLE);
    const rejected = runCheck(root, 'apps/api');
    expectCheck(rejected, 'fail', 'apps/api after injecting dist/a.ts and dist/b.ts');
    expect(rejected.output).toContain(NO_IMPORT_CYCLES);
  });

  test('keeps node_modules and git internals outside the TS/JS scan', async () => {
    const root = createFixture();
    const files = {
      ...TYPE_CYCLE,
      'self.js': "import { self } from './self.js';\nexport { self };\n",
    };
    injectCycle(root, 'apps/api/node_modules/fixture-dependency', files);
    injectCycle(root, 'apps/api/.git', files);
    expectCycleCount(await countCycles(root, ['apps/api']), 0, 'apps/api node_modules and .git');
    expectCheck(
      runCheck(root, 'apps/api'),
      'pass',
      'apps/api with cycles only in node_modules/.git'
    );
  });

  test('ignores witness-like source comments in actual Biome diagnostics', async () => {
    const root = createFixture();
    injectCycle(root, 'apps/api', {
      ...VALUE_CYCLE,
      'a.ts':
        "import { b } from './b'; // This import resolves to bogus.ts\n" +
        '// ... which imports spoof.ts\n' +
        '// ... which imports bogus.ts\n' +
        'export const a = () => b();\n',
    });
    expectCycleCount(await countCycles(root, ['apps/api']), 1, 'apps/api witness-like comments');
  });

  test('reports an independent scripts cycle even while all workspace graphs are clean', async () => {
    const root = createFixture();
    injectCycle(root, 'scripts', VALUE_CYCLE);
    expectCycleCount(
      await countCycles(root, [...WORKSPACES, 'scripts']),
      1,
      'scripts cycle beside clean workspaces'
    );
  });

  test('counts branching cycles through tsconfig aliases', async () => {
    const root = createFixture();
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
    expectCycleCount(await countCycles(root, ['apps/api']), 2, 'apps/api tsconfig alias cycles');
  });

  test('keeps every cycle beyond the default twenty-diagnostic limit', async () => {
    const root = createFixture();
    for (let index = 0; index < 12; index++) {
      injectCycle(root, `apps/api/src/cycle-${index}`, TYPE_CYCLE);
    }
    expectCycleCount(await countCycles(root, ['apps/api']), 12, 'apps/api cycle-0..cycle-11');
  });

  test.each(['canonical', 'alias'])(
    'counts a cycle through package exports once from a %s parent',
    async (spelling) => {
      const parent = mkdtempSync(join(tmpdir(), 'mango-import-cycles-parent-'));
      fixtures.push(parent);
      const alias = `${parent}-alias`;
      if (spelling === 'alias') {
        symlinkSync(parent, alias, 'junction');
        fixtures.push(alias);
      }
      const root = createFixture(spelling === 'alias' ? alias : parent);
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
      expectCycleCount(
        await countCycles(root, ['apps/api', 'apps/shared']),
        1,
        'api <-> shared package exports'
      );
    }
  );
});
