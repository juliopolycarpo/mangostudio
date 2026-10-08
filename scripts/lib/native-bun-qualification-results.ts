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

function normalizedPath(path: string): string {
  return posix.normalize(path.replaceAll('\\', '/').replace(/^\.\//, ''));
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
      'Unknown default test producer; expected full root/protocol/API/shared/frontend lanes'
    );
  }
  const lanes: NativeTestLane[] = [];
  for (const [id, task, cwd, directory, key] of EXPECTED_LANES) {
    const manifest = cwd ? `${cwd}/package.json` : 'package.json';
    const source = cwd ? await Bun.file(join(root, manifest)).json() : rootManifest;
    const script =
      id === 'protocol' ? 'bun test --timeout 15000 packages/protocol' : source.scripts?.[key];
    if (typeof script !== 'string' || (id !== 'protocol' && !script.includes(directory))) {
      throw new Error(
        `Invalid ${manifest} ${key}: ${JSON.stringify(script)}; expected ${directory} suite`
      );
    }
    const prefix = cwd ? `${cwd}/${directory}/` : `${directory}/`;
    const files = trackedFiles.filter((file) => file.startsWith(prefix) && TEST_FILE.test(file));
    if (!files.length)
      throw new Error(`Empty ${id} inventory; expected tracked test files below ${prefix}`);
    lanes.push({ id, task, cwd, manifest, script, files });
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
  summaries: { tests: number; files: number }[];
  errors: string[];
}

function splitTask(line: string): { task: string; body: string } {
  const clean = line.replace(ANSI, '').replace(/\r$/, '');
  const match =
    /^(\/\/#test:scripts|\/\/:test:scripts|@[\w/-]+:test:(?:unit|integration)):\s*/.exec(clean);
  return {
    task: match?.[1].replace('//:test:scripts', '//#test:scripts') ?? '',
    body: (match ? clean.slice(match[0].length) : clean).trim(),
  };
}

function recordLine(lane: MutableLane, body: string, line: number, cwd: string): void {
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
  if (summary) lane.summaries.push({ tests: Number(summary[1]), files: Number(summary[2]) });
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
 * @example parseNativeTestLog(await Bun.file('/out/logs/test.log').text(), inventory, rootJunit);
 */
export function parseNativeTestLog(
  log: string,
  inventory: readonly NativeTestLane[],
  rootJunit: JunitCounts | null
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
    const summary = lane.summaries.length === 1 ? lane.summaries[0] : null;
    const files = [...lane.files];
    const missing = spec.files.filter((file) => !lane.files.has(file));
    if (missing.length)
      errors.push(`Missing ${missing.length} required files: ${missing.join(', ')}`);
    if (lane.id === 'root') {
      if (!rootJunit || rootJunit.truncated || rootJunit.tests === 0)
        errors.push('Missing, empty, or truncated root JUnit');
      if (rootJunit && rootJunit.failed > 0)
        errors.push(`${rootJunit.failed} failing root testcases`);
      // Fixtures printed by root tooling tests are not root suite failures.
      const cases = (rootJunit?.cases ?? []).map((testCase) => ({
        line: 0,
        file: testCase.file ? normalizedPath(testCase.file) : null,
        name: testCase.identity,
        outcome: testCase.outcome,
      }));
      return {
        id: lane.id,
        files,
        cases,
        recaps: [],
        summary: rootJunit
          ? { tests: rootJunit.tests, files: new Set(cases.map((testCase) => testCase.file)).size }
          : null,
        errors: errors.filter((error) => !error.startsWith('line ')),
      };
    }
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
  let log = '';
  try {
    log = await readFile(join(out, 'logs/test.log'), 'utf8');
  } catch (error) {
    errors.push(`Test log unavailable: ${String(error)}`);
  }
  const rootJunit = junit.find((report) => report.path === 'junit/root.xml')?.counts ?? null;
  const lanes = parseNativeTestLog(log, inventory, rootJunit);
  errors.push(...lanes.flatMap((lane) => lane.errors.map((error) => `${lane.id}: ${error}`)));
  return { inventory, lanes, junit, errors, complete: errors.length === 0 };
}
