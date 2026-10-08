import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseJunitXml } from '../lib/junit-report';
import { laneById } from '../lib/test-lanes';
import { startWorkerProcess } from '../lib/test-worker-process';
import { discoverTestFiles, laneSpec, planWorkers } from '../lib/test-workers';

const reports: string[] = [];
afterEach(() => {
  for (const directory of reports.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Runs one original fixture through the root worker's real plan, launcher and orphan policy. */
async function runFixture(pattern: string, file: string) {
  const directory = mkdtempSync(join(tmpdir(), 'mangostudio-supervision-fixture-'));
  reports.push(directory);
  const spec = laneSpec(laneById('root'), [
    'bun',
    'test',
    '--timeout',
    '15000',
    '--test-name-pattern',
    pattern,
    'scripts',
  ]);
  const plan = planWorkers(spec, 1, directory)[0];
  if (!plan) throw new Error('expected a one-worker plan | received: none');
  expect(plan.argv).toContain('--no-orphans');
  const lines: string[] = [];
  const recordLine = (line: string): void => {
    lines.push(line);
  };
  const exit = await startWorkerProcess(plan, '', { out: recordLine, err: recordLine }).exited;
  expect(
    exit,
    `expected the fixture to pass under --no-orphans | received: ${lines.join('\n')}`
  ).toEqual({ exitCode: 0, signal: null });
  const report = parseJunitXml(readFileSync(plan.reportPath, 'utf8'));
  expect(report.truncated).toBeNull();
  expect(report.failed).toBe(0);
  expect(report.passed).toBe(1);
  expect(report.tests).toBe(report.skipped + 1);
  expect(report.cases.filter((test) => test.outcome === 'passed').map((test) => test.file)).toEqual(
    [file]
  );
  // Bun inventories filtered cases as skipped. Require the full actual lane
  // file census as well as the selected case, rather than assuming one case.
  expect([...new Set(report.cases.map((test) => test.file))].sort()).toEqual(
    [...discoverTestFiles(spec.cwd, spec.testDir), ...(spec.alsoRuns ?? [])].sort()
  );
}

describe('controlled process fixtures under a root worker', () => {
  it.skipIf(process.platform !== 'linux')(
    'keeps resistant token children available for cancellation under the root orphan policy',
    async () => {
      await runFixture(
        'reaps SIGTERM-resistant leaders and token children before the outer deadline',
        'scripts/tests/test-workers-cancel.unit.test.ts'
      );
    }
  );

  it('keeps the inherited-stdout failure and the original child exit status', async () => {
    await runFixture(
      'keeps the exit status of a child that died holding stdout open',
      'scripts/tests/runtime-handshake.unit.test.ts'
    );
  });

  it.skipIf(process.platform === 'win32')(
    'keeps exactly one SIGINT delivery to each child of the nested runner',
    async () => {
      await runFixture(
        'reaches the children of a nested runner exactly once',
        'scripts/tests/exec-process-tree.unit.test.ts'
      );
    }
  );

  it('keeps the leaked pipe alive until the worker drain grace', async () => {
    await runFixture(
      'does not hold the lane open past the drain grace, and still passes',
      'scripts/tests/test-workers-process.unit.test.ts'
    );
  });

  it('leaves the crashed attempt stray for the watchdog to reap', async () => {
    await runFixture(
      "reaps a crashed attempt's process group before retrying",
      'scripts/tests/run-tests-watchdog.unit.test.ts'
    );
  });
});
