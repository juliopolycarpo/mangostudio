import { afterEach, describe, expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ROOT_DIR } from '../lib/config';
import {
  collectNativeTestEvidence,
  type NativeTestLane,
  nativeTestInventory,
  parseNativeTestLog,
} from '../lib/native-bun-qualification-results';
import { parseJunitXml } from '../qa-gate/junit-results';

const inventory: NativeTestLane[] = [
  {
    id: 'root',
    task: '//#test:scripts',
    cwd: '',
    manifest: 'package.json',
    script: 'bun test scripts',
    files: ['scripts/root.test.ts'],
  },
  {
    id: 'api-unit',
    task: '@mangostudio/api:test:unit',
    cwd: 'apps/api',
    manifest: 'apps/api/package.json',
    script: 'bun test tests/unit',
    files: ['apps/api/tests/unit/real.test.ts'],
  },
  {
    id: 'protocol',
    task: '',
    cwd: '',
    manifest: 'package.json',
    script: 'bun test packages/protocol',
    files: ['packages/protocol/real.test.ts'],
  },
];
const root = parseJunitXml(
  '<testsuites tests="1"><testcase name="real root test" file="scripts/root.test.ts" /></testsuites>'
);

function completeLog(): string {
  return [
    '//:test:scripts: scripts/root.test.ts:',
    '//:test:scripts: (fail) some suite > quoted by a fixture [1.00ms]',
    '//:test:scripts: @mangostudio/api:test:unit: (fail) nested quoted fixture',
    '//:test:scripts: 1 error',
    '@mangostudio/api:test:unit: tests/unit/real.test.ts:',
    '@mangostudio/api:test:unit: (pass) real API case [1.00ms]',
    '@mangostudio/api:test:unit: 1 pass',
    '@mangostudio/api:test:unit: 0 fail',
    '@mangostudio/api:test:unit: Ran 1 test across 1 file. [1.00ms]',
    'packages/protocol/real.test.ts:',
    '(skip) optional protocol interop',
    'Ran 1 test across 1 file. [1.00ms]',
  ].join('\n');
}

describe('default suite raw evidence', () => {
  test('counts skipped cases once when Bun repeats them in its final recap', () => {
    const recapped = completeLog().replace(
      '(skip) optional protocol interop\nRan',
      '(skip) optional protocol interop\n1 test skipped:\n(skip) optional protocol interop\nRan'
    );
    const lanes = parseNativeTestLog(recapped, inventory, root);
    expect(lanes[2].cases).toHaveLength(1);
    expect(lanes[2].recaps).toHaveLength(1);
    expect(lanes[2].errors).toEqual([]);
  });
  test('uses root XML and exact outer prefixes instead of counting falsified fixtures', () => {
    const lanes = parseNativeTestLog(completeLog(), inventory, root);
    expect(lanes.map((lane) => lane.errors)).toEqual([[], [], []]);
    expect(lanes[0].cases).toEqual([
      {
        line: 0,
        file: 'scripts/root.test.ts',
        name: 'scripts/root.test.ts||real root test|',
        outcome: 'passed',
      },
    ]);
    expect(lanes[1].cases).toHaveLength(1);
    expect(lanes[1].cases[0].name).toBe('real API case');
    expect(lanes[2].cases[0].outcome).toBe('skipped');
  });

  test('rejects filtered cases even when every required file has a reporter header', () => {
    const filtered = completeLog().replace(
      '@mangostudio/api:test:unit: 0 fail',
      '@mangostudio/api:test:unit: 9 filtered out\n@mangostudio/api:test:unit: 0 fail'
    );
    const lanes = parseNativeTestLog(filtered, inventory, root);
    expect(lanes[1].errors.join('\n')).toContain('9 filtered testcases');
  });

  test('requires every root file to have an authoritative JUnit testcase', () => {
    const required = [
      { ...inventory[0], files: [...inventory[0].files, 'scripts/filtered.test.ts'] },
    ];
    const headers = `${completeLog()}\n//:test:scripts: scripts/filtered.test.ts:`;
    const lanes = parseNativeTestLog(headers, required, root);
    expect(lanes[0].errors.join('\n')).toContain(
      'Missing 1 required JUnit files: scripts/filtered.test.ts'
    );
  });

  test('rejects the real root filtered footer while ignoring quoted fixture footers', () => {
    const fixture = completeLog().replace(
      '//:test:scripts: 1 error',
      '//:test:scripts: 1 pass\n//:test:scripts: 9 filtered out\n//:test:scripts: Ran 1 test across 1 file.'
    );
    const footer = [
      '//:test:scripts: 1 pass',
      '//:test:scripts: 0 fail',
      '//:test:scripts: Ran 1 test across 1 file.',
    ].join('\n');
    expect(parseNativeTestLog(`${fixture}\n${footer}`, inventory, root)[0].errors).toEqual([]);
    const filtered = footer.replace(
      '//:test:scripts: 0 fail',
      '//:test:scripts: 9 filtered out\n//:test:scripts: 0 fail'
    );
    expect(
      parseNativeTestLog(`${fixture}\n${filtered}`, inventory, root)[0].errors.join('\n')
    ).toContain('9 filtered testcases');
  });

  test('refuses a zero-exit shape with missing lanes or no case records', () => {
    const absent = parseNativeTestLog('//:test:scripts: scripts/root.test.ts:', inventory, root);
    expect(absent[1].errors.join('\n')).toContain('Missing 1 required files');
    expect(absent[1].errors.join('\n')).toContain('No testcase outcomes');
    const empty = parseNativeTestLog(
      completeLog().replace('@mangostudio/api:test:unit: (pass) real API case [1.00ms]', ''),
      inventory,
      root
    );
    expect(empty[1].errors.join('\n')).toContain('differs from 0 cases');
  });

  test('preserves failures, unhandled errors, and truncated summaries', () => {
    const failed = parseNativeTestLog(
      completeLog()
        .replace('(pass) real API case', '(fail) real API case')
        .replace(
          '@mangostudio/api:test:unit: 0 fail',
          '@mangostudio/api:test:unit: # Unhandled error between tests'
        ),
      inventory,
      root
    );
    expect(failed[1].cases[0].outcome).toBe('failed');
    expect(failed[1].errors.join('\n')).toContain('Unhandled error between tests');
    expect(failed[1].errors.join('\n')).toContain('Failing testcase');
    const truncated = parseNativeTestLog(
      completeLog().replace('Ran 1 test across 1 file. [1.00ms]', ''),
      inventory,
      root
    );
    expect(truncated[1].errors.join('\n')).toContain('Expected one complete Bun summary');
    const missingXml = parseNativeTestLog(completeLog(), inventory, null);
    expect(missingXml[0].errors).toContain('Missing, empty, or truncated root JUnit');
  });

  test('normalizes ANSI and Windows relative file paths without losing outcome identity', () => {
    const ansiEscape = String.fromCharCode(27);
    const log = completeLog().replace(
      'tests/unit/real.test.ts:',
      `${ansiEscape}[32mtests\\unit\\real.test.ts:${ansiEscape}[0m\r`
    );
    const lanes = parseNativeTestLog(log, inventory, root);
    expect(lanes[1].files).toEqual(['apps/api/tests/unit/real.test.ts']);
    expect(lanes[1].errors).toEqual([]);
  });
});

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const overlap = 'apps/api/tests/unit/modules/environments/runtime-slot-scripts.test.ts';
const integrationOverlap =
  'apps/api/tests/integration/modules/environments/wsl-runtime-scripts.integration.test.ts';
const workerInventory: NativeTestLane[] = [
  {
    ...inventory[0],
    task: '//#test:scripts:workers',
    files: ['scripts/root.test.ts', overlap],
    report: '.mango/artifacts/test-workers/root.xml',
  },
  { ...inventory[1], files: [overlap], report: '.mango/artifacts/test-workers/api-unit.xml' },
  inventory[2],
];
const workerRootXml = `<testsuites tests="3"><testcase file="scripts/root.test.ts" name="root pass" /><testcase file="scripts/root.test.ts" name="root todo"><skipped message="TODO" /></testcase><testcase file="${overlap}" name="shared skip"><skipped /></testcase></testsuites>`;
const workerApiXml =
  '<testsuites tests="1"><testcase file="tests/unit/modules/environments/runtime-slot-scripts.test.ts" name="shared skip"><skipped /></testcase></testsuites>';

function workerLog(): string {
  return [
    '//:test:scripts:workers: [root 1/2] (fail) quoted fixture',
    '//:test:scripts:workers: [root 1/2] 1 pass',
    '//:test:scripts:workers: [root 1/2] 9 filtered out',
    '//:test:scripts:workers: [root 1/2] Ran 1 test across 1 file.',
    '//:test:scripts:workers: [root 1/2] 1 pass',
    '//:test:scripts:workers: [root 1/2] 0 fail',
    '//:test:scripts:workers: [root 1/2] Ran 2 tests across 1 file.',
    '//:test:scripts:workers: [root 2/2] 0 pass',
    '//:test:scripts:workers: [root 2/2] 1 skip',
    '//:test:scripts:workers: [root 2/2] Ran 1 test across 1 file.',
    '@mangostudio/api:test:unit: [api-unit 1/1] 0 pass',
    '@mangostudio/api:test:unit: [api-unit 1/1] 1 skip',
    '@mangostudio/api:test:unit: [api-unit 1/1] Ran 1 test across 1 file.',
    'packages/protocol/real.test.ts:',
    '(skip) optional protocol interop',
    'Ran 1 test across 1 file.',
  ].join('\n');
}

function workerReports() {
  return { root: parseJunitXml(workerRootXml), 'api-unit': parseJunitXml(workerApiXml) };
}

async function fixtureFile(root: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

async function producerFixture(workers: boolean): Promise<{ root: string; files: string[] }> {
  const root = await mkdtemp(join(tmpdir(), 'native-worker-producer-'));
  temporary.push(root);
  const manifests = [
    'package.json',
    'apps/api/package.json',
    'apps/shared/package.json',
    'apps/frontend/package.json',
  ];
  for (const path of [...manifests, 'scripts/test.ts', 'scripts/lib/config.ts']) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await cp(join(ROOT_DIR, path), join(root, path));
  }
  const files = [
    'scripts/root.test.ts',
    'packages/protocol/real.test.ts',
    overlap,
    integrationOverlap,
    'apps/shared/tests/unit/shared.test.ts',
    'apps/frontend/tests/unit/frontend.test.ts',
    'apps/frontend/tests/integration/frontend.test.ts',
  ];
  const manifest = await Bun.file(join(root, 'package.json')).json();
  delete manifest.scripts['test:scripts:workers'];
  manifest.scripts['test:scripts'] =
    'mkdir -p .mango/artifacts/junit && bun test --timeout 15000 --reporter=junit --reporter-outfile=.mango/artifacts/junit/root.xml $MANGOSTUDIO_BUN_TEST_ARGS scripts';
  const api = await Bun.file(join(root, 'apps/api/package.json')).json();
  api.scripts['test:unit'] =
    'MANGOSTUDIO_DIAGNOSTIC_LOGS=0 bun ../../scripts/with-test-home.ts bun test --timeout 15000 --parallel=1 tests/unit';
  api.scripts['test:integration'] =
    'MANGOSTUDIO_DIAGNOSTIC_LOGS=0 bun ../../scripts/with-test-home.ts bun test --timeout 15000 tests/integration';
  const producer =
    "const unit = !hasExplicitLaneSelection || runUnitLane; const integration = !hasExplicitLaneSelection || runIntegrationLane; workspaceLaneTasks('test:unit'); workspaceLaneTasks('test:integration');\n";
  await fixtureFile(root, 'scripts/test.ts', producer);
  await fixtureFile(root, 'package.json', JSON.stringify(manifest));
  await fixtureFile(root, 'apps/api/package.json', JSON.stringify(api));
  if (!workers) return { root, files };
  manifest.scripts['test:scripts:workers'] =
    'bun ./scripts/run-test-workers.ts --lane=root -- bun test --timeout 15000 scripts';
  await fixtureFile(root, 'package.json', JSON.stringify(manifest));
  api.scripts['test:unit'] =
    'MANGOSTUDIO_DIAGNOSTIC_LOGS=0 bun ../../scripts/run-test-workers.ts --lane=api-unit -- bun test --timeout 15000 --parallel=1 tests/unit';
  api.scripts['test:integration'] =
    'MANGOSTUDIO_DIAGNOSTIC_LOGS=0 bun ../../scripts/run-test-workers.ts --lane=api-integration -- bun test --timeout 15000 tests/integration';
  await fixtureFile(root, 'apps/api/package.json', JSON.stringify(api));
  await fixtureFile(
    root,
    'scripts/test.ts',
    `${producer}\ncreateRootScriptsCommand(phase, rootScriptsBase); rootScriptsTask('unit');\n`
  );
  await fixtureFile(
    root,
    'scripts/lib/test.ts',
    "const task = phase === 'unit' ? '//#test:scripts:workers' : '//#test:scripts';\n"
  );
  await fixtureFile(
    root,
    'scripts/lib/test-lanes.ts',
    `export const lanes = [{ id: 'root', workers: { alsoRuns: ['${integrationOverlap}', '${overlap}'] } }];\n`
  );
  return { root, files };
}

describe('accepted native producers', () => {
  test('supports direct and worker profiles with both root/API file claims intact', async () => {
    for (const workers of [false, true]) {
      const source = await producerFixture(workers);
      const lanes = await nativeTestInventory(source.root, source.files);
      expect(lanes).toHaveLength(7);
      expect(lanes[0].task).toBe(workers ? '//#test:scripts:workers' : '//#test:scripts');
      expect(lanes[0].files).toContain(overlap);
      expect(lanes[0].files).toContain(integrationOverlap);
      expect(lanes.find((lane) => lane.id === 'api-unit')?.files).toContain(overlap);
      expect(lanes.find((lane) => lane.id === 'api-integration')?.files).toContain(
        integrationOverlap
      );
      expect(lanes.filter((lane) => lane.report).map((lane) => lane.report)).toEqual(
        workers
          ? [
              '.mango/artifacts/test-workers/root.xml',
              '.mango/artifacts/test-workers/api-unit.xml',
              '.mango/artifacts/test-workers/api-integration.xml',
            ]
          : []
      );
    }
  });

  test('rejects directory sub-suites, changed flags, retry flags, and coverage substitutions', async () => {
    const source = await producerFixture(true);
    const api = await Bun.file(join(source.root, 'apps/api/package.json')).json();
    const original = api.scripts['test:unit'];
    for (const script of [
      original.replace('tests/unit', 'tests/unit/subset'),
      `${original} --changed=main`,
      `${original} --retry=2`,
      `${original} --coverage`,
    ]) {
      api.scripts['test:unit'] = script;
      await fixtureFile(source.root, 'apps/api/package.json', JSON.stringify(api));
      await expect(nativeTestInventory(source.root, source.files)).rejects.toThrow(
        /expected (?:an unfiltered single-attempt suite|accepted worker producer)/
      );
    }
  });

  test('refuses a worker helper or alsoRuns inventory that has drifted', async () => {
    const source = await producerFixture(true);
    await fixtureFile(
      source.root,
      'scripts/lib/test-lanes.ts',
      "const lanes = [{ id: 'root', alsoRuns: [] }];\n"
    );
    await expect(nativeTestInventory(source.root, source.files)).rejects.toThrow(
      'Unknown worker root inventory'
    );
    await fixtureFile(source.root, 'scripts/lib/test.ts', "const task = '//#test:scripts';\n");
    await expect(nativeTestInventory(source.root, source.files)).rejects.toThrow(
      'Unknown default test producer'
    );
  });
});

describe('authoritative worker evidence', () => {
  test('keeps pass/skip/todo outcomes and overlapping cases in each lane', () => {
    const lanes = parseNativeTestLog(workerLog(), workerInventory, root, workerReports());
    expect(lanes.map((lane) => lane.errors)).toEqual([[], [], []]);
    expect(lanes[0].cases.map((item) => item.outcome)).toEqual(['passed', 'todo', 'skipped']);
    expect(lanes[1].cases[0].file).toBe(overlap);
    expect(lanes[0].cases[2].file).toBe(overlap);
    expect(lanes[0].summary?.tests).toBe(3);
    expect(lanes[1].summary?.tests).toBe(1);
    // Windows emits no worker prefix for its single worker.
    const single = [
      ...workerLog()
        .split('\n')
        .filter((line) => !line.startsWith('//:test:scripts:workers:')),
      '//:test:scripts:workers: 1 pass',
      '//:test:scripts:workers: 0 fail',
      '//:test:scripts:workers: Ran 3 tests across 2 files.',
    ].join('\n');
    expect(parseNativeTestLog(single, workerInventory, null, workerReports())[0].errors).toEqual(
      []
    );
  });

  test('rejects missing, truncated, failed, fileless, unexpected, and undercounted reports', () => {
    for (const xml of [
      '<testsuites tests="3">',
      workerRootXml.replace(
        'name="root pass" />',
        'name="root pass"><failure message="failed" /></testcase>'
      ),
      workerRootXml.replace('file="scripts/root.test.ts"', ''),
      workerRootXml.replaceAll('scripts/root.test.ts', 'scripts/unexpected.test.ts'),
      workerRootXml
        .replace('tests="3"', 'tests="2"')
        .replace('<testcase file="scripts/root.test.ts" name="root pass" />', ''),
    ]) {
      const reports = { ...workerReports(), root: parseJunitXml(xml) };
      expect(
        parseNativeTestLog(workerLog(), workerInventory, root, reports)[0].errors.length
      ).toBeGreaterThan(0);
    }
    expect(parseNativeTestLog(workerLog(), workerInventory, root)[0].errors).toContain(
      'Missing, empty, or truncated root worker JUnit'
    );
    expect(parseNativeTestLog('', workerInventory, root, workerReports())[0].errors).toContain(
      'Missing complete worker Bun summaries'
    );
  });

  test('rejects each worker actual filtered footer while ignoring quoted fixture footers', () => {
    const filtered = workerLog().replace('[root 2/2] 1 skip', '[root 2/2] 9 filtered out');
    expect(
      parseNativeTestLog(filtered, workerInventory, root, workerReports())[0].errors.join('\n')
    ).toContain('9 filtered testcases');
  });

  test('retains merged worker XML and raw output separately from coverage', async () => {
    const source = await producerFixture(true);
    const out = join(source.root, 'receipts');
    await fixtureFile(
      source.root,
      '.mango/artifacts/junit/root.xml',
      '<testsuites tests="1"><testcase file="scripts/coverage-only.test.ts" name="coverage" /></testsuites>'
    );
    await fixtureFile(source.root, '.mango/artifacts/test-workers/root.xml', workerRootXml);
    await fixtureFile(source.root, '.mango/artifacts/test-workers/api-unit.xml', workerApiXml);
    await fixtureFile(
      source.root,
      '.mango/artifacts/test-workers/worker-1-of-2.xml',
      'temporary report'
    );
    await fixtureFile(source.root, '.turbo/turbo-test-workers.log', 'raw worker output');
    await fixtureFile(out, 'logs/test.log', workerLog());
    const evidence = await collectNativeTestEvidence(source.root, out, workerInventory);
    expect(evidence.complete).toBe(true);
    expect(evidence.lanes[0].files).not.toContain('scripts/coverage-only.test.ts');
    expect(await readFile(join(out, 'test-workers/root.xml'), 'utf8')).toBe(workerRootXml);
    expect((await readdir(join(out, 'test-workers'))).sort()).toEqual(['api-unit.xml', 'root.xml']);
    expect(await readFile(join(out, 'workspace-output/root/turbo-test-workers.log'), 'utf8')).toBe(
      'raw worker output'
    );
    await rm(join(source.root, '.mango/artifacts/test-workers/root.xml'));
    expect((await collectNativeTestEvidence(source.root, out, workerInventory)).complete).toBe(
      false
    );
  });
});
