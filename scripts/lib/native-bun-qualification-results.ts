import { cp, mkdir, readdir, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';

import { type JunitCounts, parseJunitXml } from '../qa-gate/junit-results';

export interface NativeTestLane {
  readonly id: string;
  readonly task: string;
  readonly cwd: string;
  readonly manifest: string;
  readonly script: string;
  readonly files: readonly string[];
  /** Source-owned authoritative report for a worker lane, separate from coverage. */
  readonly report?: string;
}

interface NativeCaseRecord {
  readonly line: number;
  readonly file: string | null;
  readonly name: string;
  readonly outcome: 'passed' | 'failed' | 'skipped' | 'todo';
}

export interface NativeLaneResult {
  readonly id: string;
  readonly files: readonly string[];
  readonly cases: readonly NativeCaseRecord[];
  readonly recaps: readonly NativeCaseRecord[];
  readonly summary: { tests: number; files: number } | null;
  readonly errors: readonly string[];
}

export interface NativeTestEvidence {
  readonly inventory: readonly NativeTestLane[];
  readonly lanes: readonly NativeLaneResult[];
  readonly junit: readonly { path: string; counts: JunitCounts }[];
  readonly errors: readonly string[];
  readonly complete: boolean;
}

const EXPECTED_LANES = [
  ['root', '//#test:scripts', '', 'scripts', 'test:scripts'],
  ['protocol', '', '', 'packages/protocol', 'test'],
  ['api-unit', '@mangostudio/api:test:unit', 'apps/api', 'tests/unit', 'test:unit'],
  ['shared-unit', '@mangostudio/shared:test:unit', 'apps/shared', 'tests/unit', 'test:unit'],
  ['frontend-unit', '@mangostudio/frontend:test:unit', 'apps/frontend', 'tests/unit', 'test:unit'],
  [
    'api-integration',
    '@mangostudio/api:test:integration',
    'apps/api',
    'tests/integration',
    'test:integration',
  ],
  [
    'frontend-integration',
    '@mangostudio/frontend:test:integration',
    'apps/frontend',
    'tests/integration',
    'test:integration',
  ],
] as const;

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');

const DIRECT_SCRIPTS: Readonly<Record<string, string>> = {
  root: 'mkdir -p .mango/artifacts/junit && bun test --timeout 15000 --reporter=junit --reporter-outfile=.mango/artifacts/junit/root.xml $MANGOSTUDIO_BUN_TEST_ARGS scripts',
  'api-unit':
    'MANGOSTUDIO_DIAGNOSTIC_LOGS=0 bun ../../scripts/with-test-home.ts bun test --timeout 15000 --parallel=1 tests/unit',
  'api-integration':
    'MANGOSTUDIO_DIAGNOSTIC_LOGS=0 bun ../../scripts/with-test-home.ts bun test --timeout 15000 tests/integration',
  'shared-unit': 'bun test --timeout 15000 tests/unit',
  'frontend-unit':
    'bun test --tsconfig-override=./tsconfig.test.json --parallel=4 --isolate --timeout 15000 tests/unit',
  'frontend-integration':
    'bun test --tsconfig-override=./tsconfig.test.json --parallel=4 --isolate --timeout 15000 tests/integration',
  protocol: 'bun test --timeout 15000 packages/protocol',
};
const WORKER_SCRIPTS: Readonly<Record<string, string>> = {
  root: 'bun ./scripts/run-test-workers.ts --lane=root -- bun test --timeout 15000 scripts',
  'api-unit':
    'MANGOSTUDIO_DIAGNOSTIC_LOGS=0 bun ../../scripts/run-test-workers.ts --lane=api-unit -- bun test --timeout 15000 --parallel=1 tests/unit',
  'api-integration':
    'MANGOSTUDIO_DIAGNOSTIC_LOGS=0 bun ../../scripts/run-test-workers.ts --lane=api-integration -- bun test --timeout 15000 tests/integration',
};

function normalizedPath(path: string): string {
  return posix.normalize(path.replaceAll('\\', '/').replace(/^\.\//, ''));
}

/** The quoted items of an argv array literal, and whatever else it holds besides them. */
function argvLiteral(literal: string | undefined): { items: string[]; rest: string } {
  const text = literal ?? '';
  return {
    items: [...text.matchAll(/'([^']*)'/g)].map((item) => item[1]),
    rest: text.replace(/'[^']*'/g, '').replace(/[\s,]/g, ''),
  };
}

/**
 * Read the command the source's protocol lane runs. The lane has no package script: the
 * producer starts a launcher, and the launcher's TypeScript task holds the Bun argv, with only
 * the launcher's own pass-through arguments appended, which the producer never supplies.
 */
async function protocolLaneScript(root: string, producer: string): Promise<string> {
  const tasks = await readFile(join(root, 'scripts/protocol/tasks.ts'), 'utf8');
  const launcher = argvLiteral(/const PROTOCOL_TEST_COMMAND = \[([^\]]*)\];/.exec(producer)?.[1]);
  const suite = argvLiteral(/label: 'protocol:bun-test',\s*cmd: \[([^\]]*)\]/.exec(tasks)?.[1]);
  if (
    !producer.includes("runCommand('root:test:protocol', PROTOCOL_TEST_COMMAND") ||
    launcher.items.join(' ') !== 'bun ./scripts/protocol/test.ts --ts-only' ||
    launcher.rest !== '' ||
    suite.items.length === 0 ||
    suite.rest !== '...bunTestArgs'
  ) {
    throw new Error(
      `Unknown protocol test producer ${JSON.stringify(launcher)} running ${JSON.stringify(suite)}; expected the --ts-only launcher and its one literal Bun suite argv`
    );
  }
  return suite.items.join(' ');
}

/**
 * Inventory every tracked test file selected by the source's default lanes.
 * Refuse an unfamiliar producer instead of certifying a smaller test command.
 * @example await nativeTestInventory('/checkout', source.files.map(file => file.path));
 */
export async function nativeTestInventory(
  root: string,
  trackedFiles: readonly string[]
): Promise<NativeTestLane[]> {
  const rootManifest = await Bun.file(join(root, 'package.json')).json();
  const producer = await readFile(join(root, 'scripts/test.ts'), 'utf8');
  const config = await readFile(join(root, 'scripts/lib/config.ts'), 'utf8');
  if (
    rootManifest.scripts?.test !== 'bun ./scripts/test.ts' ||
    !producer.includes('!hasExplicitLaneSelection || runUnitLane') ||
    !producer.includes('!hasExplicitLaneSelection || runIntegrationLane') ||
    !producer.includes("workspaceLaneTasks('test:unit')") ||
    !producer.includes("workspaceLaneTasks('test:integration')") ||
    !config.includes("['frontend', 'api', 'shared']")
  ) {
    throw new Error(
      `Unknown default test producer ${JSON.stringify(rootManifest.scripts?.test)}; expected full root/protocol/API/shared/frontend lanes`
    );
  }
  const workers = rootManifest.scripts?.['test:scripts:workers'] !== undefined;
  if (workers) {
    const helper = await readFile(join(root, 'scripts/lib/test.ts'), 'utf8');
    if (
      !producer.includes('createRootScriptsCommand(phase, rootScriptsBase)') ||
      !producer.includes("rootScriptsTask('unit')") ||
      !helper.includes("phase === 'unit' ? '//#test:scripts:workers' : '//#test:scripts'")
    ) {
      throw new Error(
        `Unknown default test producer helper ${JSON.stringify(rootManifest.scripts?.['test:scripts:workers'])}; expected the worker root task helper`
      );
    }
    const registry = await readFile(join(root, 'scripts/lib/test-lanes.ts'), 'utf8');
    const alsoRuns = /id:\s*'root'[\s\S]*?alsoRuns:\s*\[([\s\S]*?)\]/.exec(registry)?.[1];
    const declared = [...(alsoRuns ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]);
    const selected = trackedFiles.filter(
      (file) => TEST_FILE.test(file) && file.includes('scripts') && !file.startsWith('scripts/')
    );
    if (
      !alsoRuns ||
      selected.length !== declared.length ||
      selected.some((file) => !declared.includes(file))
    ) {
      throw new Error(
        `Unknown worker root inventory ${JSON.stringify(declared)}; expected alsoRuns ${JSON.stringify(selected)} to match Bun scripts selection`
      );
    }
  }
  const protocolScript = await protocolLaneScript(root, producer);
  const lanes: NativeTestLane[] = [];
  for (const [id, task, cwd, directory, key] of EXPECTED_LANES) {
    const manifest = cwd ? `${cwd}/package.json` : 'package.json';
    const source = cwd ? await Bun.file(join(root, manifest)).json() : rootManifest;
    const worker = workers && id in WORKER_SCRIPTS;
    const script =
      id === 'protocol'
        ? protocolScript
        : source.scripts?.[worker && id === 'root' ? 'test:scripts:workers' : key];
    // Where the script was read, for the refusals below: the protocol lane has no package script.
    const origin =
      id === 'protocol' ? 'scripts/protocol/tasks.ts protocol:bun-test' : `${manifest} ${key}`;
    if (typeof script !== 'string') {
      throw new Error(`Invalid ${origin}: ${JSON.stringify(script)}; expected ${directory} suite`);
    }
    if (
      /(?:^|\s)(?:-t[^\s]*|--(?:test-name-pattern|only|changed|shard|path-ignore-patterns|retry|rerun-each|pass-with-no-tests)(?:\s|=|$))/.test(
        script
      )
    ) {
      throw new Error(
        `Invalid ${origin}: ${JSON.stringify(script)}; expected an unfiltered single-attempt suite`
      );
    }
    const expected = worker ? WORKER_SCRIPTS[id] : DIRECT_SCRIPTS[id];
    if (script !== expected) {
      throw new Error(
        `Invalid ${origin}: ${JSON.stringify(script)}; expected accepted ${worker ? 'worker' : 'direct'} producer ${JSON.stringify(expected)}`
      );
    }
    const prefix = cwd ? `${cwd}/${directory}/` : `${directory}/`;
    const files = trackedFiles.filter(
      (file) =>
        TEST_FILE.test(file) && (id === 'root' ? file.includes('scripts') : file.startsWith(prefix))
    );
    if (!files.length)
      throw new Error(`Empty ${id} inventory; expected tracked test files below ${prefix}`);
    lanes.push({
      id,
      task: worker && id === 'root' ? '//#test:scripts:workers' : task,
      cwd,
      manifest,
      script,
      files,
      ...(worker ? { report: `.mango/artifacts/test-workers/${id}.xml` } : {}),
    });
  }
  return lanes;
}

interface MutableLane {
  id: string;
  file: string | null;
  files: Set<string>;
  cases: NativeCaseRecord[];
  recap: boolean;
  recaps: NativeCaseRecord[];
  summaries: { tests: number; files: number; line: number; worker: string }[];
  passFooters: { line: number; worker: string }[];
  filtered: { count: number; line: number; worker: string }[];
  errors: string[];
}

function splitTask(line: string): { task: string; body: string } {
  const clean = line.replace(ANSI, '').replace(/\r$/, '');
  const match =
    /^(\/\/#test:scripts(?::workers)?|\/\/:test:scripts(?::workers)?|@[\w/-]+:test:(?:unit|integration)):\s*/.exec(
      clean
    );
  return {
    task: match?.[1].replace('//:test:scripts', '//#test:scripts') ?? '',
    body: (match ? clean.slice(match[0].length) : clean).trim().replace(/^::group::/, ''),
  };
}

function recordLine(lane: MutableLane, body: string, line: number, cwd: string): void {
  const prefix = /^\[(root|api-unit|api-integration) ([1-9]\d*)\/([1-9]\d*)\]\s*/.exec(body);
  const worker = prefix?.[0].trim() ?? '';
  if (prefix) body = body.slice(prefix[0].length);
  const file = /^(.+\.(?:test|spec)\.[cm]?[jt]sx?):$/.exec(body);
  if (file) {
    lane.recap = false;
    lane.file = normalizedPath(cwd ? `${cwd}/${file[1]}` : file[1]);
    lane.files.add(lane.file);
  }
  if (/^\d+ tests? (?:skipped|failed|todo):$/.test(body)) lane.recap = true;
  const testCase = /^\((pass|fail|skip|todo)\)\s+(.*?)(?:\s+\[[\d.]+(?:ms|s)\])?$/.exec(body);
  if (testCase) {
    const outcomes = { pass: 'passed', fail: 'failed', skip: 'skipped', todo: 'todo' } as const;
    const record: NativeCaseRecord = {
      line,
      file: lane.recap ? null : lane.file,
      name: testCase[2],
      outcome: outcomes[testCase[1] as keyof typeof outcomes],
    };
    if (lane.recap) lane.recaps.push(record);
    else lane.cases.push(record);
  }
  const summary = /^Ran (\d+) tests? across (\d+) files?\./.exec(body);
  if (summary)
    lane.summaries.push({ tests: Number(summary[1]), files: Number(summary[2]), line, worker });
  if (/^\d+ pass$/.test(body)) lane.passFooters.push({ line, worker });
  const filtered = /^([1-9]\d*) filtered out$/.exec(body);
  if (filtered) lane.filtered.push({ count: Number(filtered[1]), line, worker });
  if (
    /^# Unhandled error between tests|^[1-9]\d* errors?$|oh no: Bun has crashed|panic\(main thread\)/.test(
      body
    )
  ) {
    lane.errors.push(`line ${line}: ${body}`);
  }
}

/**
 * Preserve case/file records and reject a missing, truncated, or narrowed lane.
 * Root counts use its JUnit document because tooling tests print reporter fixtures.
 * Worker counts use their merged report, retaining lane overlap and case outcomes.
 * @example parseNativeTestLog(await Bun.file('/out/logs/test.log').text(), inventory, rootJunit);
 */
export function parseNativeTestLog(
  log: string,
  inventory: readonly NativeTestLane[],
  rootJunit: JunitCounts | null,
  workerJunit: Readonly<Record<string, JunitCounts | undefined>> = {}
): NativeLaneResult[] {
  const lanes = inventory.map(
    (lane): MutableLane => ({
      id: lane.id,
      file: null,
      files: new Set(),
      cases: [],
      recap: false,
      recaps: [],
      summaries: [],
      passFooters: [],
      filtered: [],
      errors: [],
    })
  );
  const tasks = new Map(
    inventory.map((lane, index) => [lane.task, { spec: lane, lane: lanes[index] }])
  );
  for (const [index, raw] of log.split('\n').entries()) {
    const { task, body } = splitTask(raw);
    const selected = tasks.get(task);
    if (selected) recordLine(selected.lane, body, index + 1, selected.spec.cwd);
  }
  return lanes.map((lane, index) => {
    const spec = inventory[index];
    const errors = [...lane.errors];
    const record = lane.summaries.length === 1 ? lane.summaries[0] : null;
    const summary = record ? { tests: record.tests, files: record.files } : null;
    const files = [...lane.files];
    if (lane.id === 'root' || spec.report) {
      const report = spec.report ? workerJunit[spec.id] : rootJunit;
      const label = spec.report ? `${spec.id} worker JUnit` : 'root JUnit';
      if (!report || report.truncated || report.tests === 0)
        errors.push(`Missing, empty, or truncated ${label}`);
      if (report && report.failed > 0) errors.push(`${report.failed} failing ${spec.id} testcases`);
      // Fixtures printed by root tooling tests are not root suite failures.
      const cases = (report?.cases ?? []).map((testCase) => ({
        line: 0,
        file: testCase.file
          ? normalizedPath(
              spec.cwd && !normalizedPath(testCase.file).startsWith(`${spec.cwd}/`)
                ? `${spec.cwd}/${testCase.file}`
                : testCase.file
            )
          : null,
        name: testCase.identity,
        outcome: testCase.outcome,
      }));
      const junitFiles = new Set(cases.flatMap((testCase) => testCase.file ?? []));
      const missing = spec.files.filter((file) => !junitFiles.has(file));
      if (missing.length)
        errors.push(`Missing ${missing.length} required JUnit files: ${missing.join(', ')}`);
      if (spec.report) {
        const extra = [...junitFiles].filter((file) => !spec.files.includes(file));
        if (extra.length) errors.push(`Unexpected worker JUnit files: ${extra.join(', ')}`);
        if (cases.some((testCase) => testCase.file === null))
          errors.push('Worker JUnit testcase emitted without a file record');
        const summaries = [...new Set(lane.summaries.map((summary) => summary.worker))].flatMap(
          (worker) =>
            [...lane.summaries].reverse().find((summary) => summary.worker === worker) ?? []
        );
        const tests = summaries.reduce((total, summary) => total + summary.tests, 0);
        const files = summaries.reduce((total, summary) => total + summary.files, 0);
        if (!summaries.length) errors.push('Missing complete worker Bun summaries');
        if (report && (tests !== report.tests || files !== junitFiles.size))
          errors.push(
            `Worker summaries ${tests} tests/${files} files differ from JUnit ${report.tests} tests/${junitFiles.size} files`
          );
      }
      for (const worker of new Set(lane.summaries.map((summary) => summary.worker))) {
        const lastSummary = [...lane.summaries]
          .reverse()
          .find((summary) => summary.worker === worker);
        const footerStart = [...lane.passFooters]
          .reverse()
          .find(
            (footer) => footer.worker === worker && footer.line < (lastSummary?.line ?? 0)
          )?.line;
        if (!lastSummary || footerStart === undefined) continue;
        for (const filtered of lane.filtered) {
          if (
            filtered.worker === worker &&
            filtered.line > footerStart &&
            filtered.line < lastSummary.line
          )
            errors.push(`${filtered.count} filtered testcases; expected the full default suite`);
        }
      }
      return {
        id: lane.id,
        files: [...junitFiles],
        cases,
        recaps: [],
        summary: report ? { tests: report.tests, files: junitFiles.size } : null,
        errors: lane.id === 'root' ? errors.filter((error) => !error.startsWith('line ')) : errors,
      };
    }
    const missing = spec.files.filter((file) => !lane.files.has(file));
    if (missing.length)
      errors.push(`Missing ${missing.length} required files: ${missing.join(', ')}`);
    for (const filtered of lane.filtered)
      errors.push(`${filtered.count} filtered testcases; expected the full default suite`);
    if (!summary)
      errors.push(`Expected one complete Bun summary; received ${lane.summaries.length}`);
    if (summary && (summary.tests !== lane.cases.length || summary.files !== files.length)) {
      errors.push(
        `Bun summary ${summary.tests} tests/${summary.files} files differs from ${lane.cases.length} cases/${files.length} file records`
      );
    }
    if (!lane.cases.length) errors.push('No testcase outcomes recorded');
    if (lane.cases.some((testCase) => testCase.outcome === 'failed'))
      errors.push('Failing testcase outcomes recorded');
    if (lane.cases.some((testCase) => testCase.file === null))
      errors.push('Testcase emitted without a file record');
    return { id: lane.id, files, cases: lane.cases, recaps: lane.recaps, summary, errors };
  });
}

/**
 * Retain original JUnit/workspace output and attach raw and parsed lane evidence.
 * The source is never patched to enable reporters its command did not request.
 * @example await collectNativeTestEvidence(root, out, inventory);
 */
export async function collectNativeTestEvidence(
  root: string,
  out: string,
  inventory: readonly NativeTestLane[]
): Promise<NativeTestEvidence> {
  const errors: string[] = [];
  const junit: { path: string; counts: JunitCounts }[] = [];
  const directory = join(root, '.mango/artifacts/junit');
  await mkdir(join(out, 'junit'), { recursive: true });
  try {
    for (const file of await readdir(directory)) {
      if (!file.endsWith('.xml')) continue;
      await cp(join(directory, file), join(out, 'junit', file));
      const counts = parseJunitXml(await readFile(join(directory, file), 'utf8'));
      junit.push({ path: `junit/${file}`, counts });
      if (counts.truncated) errors.push(`${file}: ${counts.truncated}`);
    }
  } catch (error) {
    errors.push(`JUnit evidence unavailable: ${String(error)}`);
  }
  for (const cwd of ['', 'apps/api', 'apps/shared', 'apps/frontend']) {
    const source = join(root, cwd, '.turbo');
    try {
      const logs = (await readdir(source)).filter((file) => file.endsWith('.log'));
      const destination = join(out, 'workspace-output', cwd || 'root');
      if (logs.length) await mkdir(destination, { recursive: true });
      for (const log of logs) await cp(join(source, log), join(destination, log));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        errors.push(`Cannot retain ${source}: ${String(error)}`);
    }
  }
  const workerJunit: Record<string, JunitCounts> = {};
  for (const lane of inventory) {
    if (!lane.report) continue;
    try {
      const destination = `test-workers/${lane.id}.xml`;
      await mkdir(join(out, 'test-workers'), { recursive: true });
      await cp(join(root, lane.report), join(out, destination));
      const counts = parseJunitXml(await readFile(join(out, destination), 'utf8'));
      workerJunit[lane.id] = counts;
      junit.push({ path: destination, counts });
      if (counts.truncated) errors.push(`${lane.report}: ${counts.truncated}`);
    } catch (error) {
      errors.push(`Worker JUnit evidence unavailable for ${lane.id}: ${String(error)}`);
    }
  }
  let log = '';
  try {
    log = await readFile(join(out, 'logs/test.log'), 'utf8');
  } catch (error) {
    errors.push(`Test log unavailable: ${String(error)}`);
  }
  const rootJunit = junit.find((report) => report.path === 'junit/root.xml')?.counts ?? null;
  const lanes = parseNativeTestLog(log, inventory, rootJunit, workerJunit);
  errors.push(...lanes.flatMap((lane) => lane.errors.map((error) => `${lane.id}: ${error}`)));
  return { inventory, lanes, junit, errors, complete: errors.length === 0 };
}
