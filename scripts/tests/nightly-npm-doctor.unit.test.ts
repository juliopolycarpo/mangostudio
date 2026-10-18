import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessDoctorReport } from '../ci/verify-distribution-doctor.mjs';
import { ROOT_DIR } from '../lib/config';
import { readText } from './support/read-text';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const coreLabels = [
  'Home directory',
  'Logs directory',
  'Run directory',
  'Config',
  'Database',
  'Frontend',
  'Auth secret',
  'Instance',
  'Runtime',
  'Runtime binary',
];

function report(failures: string[]) {
  const checks = [
    ...coreLabels
      .filter((label) => !failures.includes(label))
      .map((label) => ({ label, status: 'ok', detail: 'healthy' })),
    ...failures.map((label) => ({
      label,
      status: 'fail',
      detail: label === 'locations' ? '0 of 24 present, 0 writable' : 'not installed',
    })),
  ];
  return { checks, warnings: 0, failures: failures.length };
}

function runLane(failures: string[], overrides: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nightly-npm-doctor-'));
  tempDirs.push(dir);
  const tools = join(dir, 'tools');
  mkdirSync(tools);
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report(failures)));
  // Named fake registry installer: records every requested version, and creates
  // the actual launcher path that the workflow's fresh/upgrade steps execute.
  const npm = join(tools, 'npm');
  writeFileSync(
    npm,
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -ne 5 ] || [ "$1" != install ] || [ "$2" != -g ] || [ "$3" != --no-fund ] || [ "$4" != --no-audit ]; then
  echo "Unexpected npm request: $*" >&2; exit 93
fi
version="\${!#}"
version="\${version#mangostudio@}"
case "$version" in
  0.1.1|0.1.1-canary.f009196) ;;
  *) echo "Unexpected registry version: $version" >&2; exit 94 ;;
esac
echo "install $version" >> "$RECEIPT"
mkdir -p "$NPM_CONFIG_PREFIX/bin"
cp "$FAKE_LAUNCHER" "$NPM_CONFIG_PREFIX/bin/mangostudio"
echo "$version" > "$NPM_CONFIG_PREFIX/bin/version"
`
  );
  chmodSync(npm, 0o755);
  const launcher = join(dir, 'launcher');
  writeFileSync(
    launcher,
    `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  --version) cat "$(dirname "$0")/version" ;;
  doctor)
    echo "doctor $* HOME=$HOME USERPROFILE=$USERPROFILE" >> "$RECEIPT"
    cat "$DOCTOR_REPORT"
    exit "$DOCTOR_STATUS"
    ;;
  *) echo "Unexpected launcher request: $*" >&2; exit 92 ;;
esac
`
  );
  chmodSync(launcher, 0o755);
  const workflow = Bun.YAML.parse(
    readText('.github/workflows/nightly-distribution-health.yml')
  ) as {
    jobs: { 'npm-install': { steps: { name?: string; run?: string }[] } };
  };
  const steps = workflow.jobs['npm-install'].steps.filter(
    (step) => step.name?.startsWith('Fresh install') || step.name?.startsWith('Upgrade from')
  );
  expect(steps).toHaveLength(2);
  const receipt = join(dir, 'receipt');
  const result = Bun.spawnSync({
    cmd: ['bash', '-euo', 'pipefail', '-c', steps.map((step) => step.run).join('\n')],
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PATH: `${tools}:${process.env.PATH}`,
      RUNNER_TEMP: dir,
      RUNNER_OS: 'Linux',
      NPM_VERSION: '0.1.1-canary.f009196',
      STABLE_VERSION: '0.1.1',
      DEEP_DIAGNOSTICS: 'true',
      RECEIPT: receipt,
      FAKE_LAUNCHER: launcher,
      DOCTOR_REPORT: join(dir, 'report.json'),
      DOCTOR_STATUS: failures.length ? '1' : '0',
      ...overrides,
    },
  });
  return { result, receipt: readFileSync(receipt, 'utf8') };
}

describe('nightly npm doctor contract', () => {
  test('fresh and upgraded packages survive missing optional host tools in an empty home', () => {
    const { result, receipt } = runLane([
      'Bun',
      'fnm',
      'Claude Code',
      'Codex',
      'Cursor',
      'locations',
    ]);
    expect(result.stderr.toString()).not.toContain('Unexpected');
    expect(result.exitCode).toBe(0);
    expect(receipt.match(/^install /gm)).toHaveLength(3);
    expect(receipt).toContain('install 0.1.1\ninstall 0.1.1-canary.f009196');
    expect(receipt.match(/doctor doctor --json --all/g)).toHaveLength(2);
    expect(receipt).toContain('mango-home-fresh');
    expect(receipt).toContain('mango-home-upgrade');
  });

  test('also classifies missing macOS and Windows host prerequisites', () => {
    const result = assessDoctorReport(report(['nvm', 'winget']), 1);
    expect(result.exitCode).toBe(1);
    expect(result.hostFailures.map((row: { label: string }) => row.label)).toEqual([
      'nvm',
      'winget',
    ]);
  });

  test('an auth or bundled-runtime failure still blocks the lane', () => {
    for (const label of ['Auth secret', 'Runtime binary']) {
      const { result, receipt } = runLane([label, 'Bun']);
      expect(result.exitCode).not.toBe(0);
      expect(receipt.match(/^install /gm)).toHaveLength(1);
    }
  });

  test('preserves unexpected process failures even with otherwise healthy JSON', () => {
    for (const status of ['1', '2', '137']) {
      expect(runLane([], { DOCTOR_STATUS: status }).result.exitCode).not.toBe(0);
    }
    expect(runLane(['Bun'], { DOCTOR_STATUS: '0' }).result.exitCode).not.toBe(0);
  });

  test('rejects incomplete, malformed or contradictory doctor reports', () => {
    for (const value of [null, {}, { checks: [] }]) {
      expect(() => assessDoctorReport(value, 0)).toThrow('expected a non-empty checks array');
    }
    expect(() => assessDoctorReport({ ...report([]), failures: 1 }, 0)).toThrow(
      'expected counters failures=0 warnings=0 | received: failures=1 warnings=0'
    );
    expect(() => assessDoctorReport(report([]), 1)).toThrow(
      '(doctor exit): expected 0 | received: 1'
    );
    const incomplete = report([]);
    incomplete.checks.pop();
    expect(() => assessDoctorReport(incomplete, 0)).toThrow(
      '(distribution check Runtime binary): expected exactly one ok row | received: missing'
    );
    const duplicate = report([]);
    duplicate.checks.push({ label: 'Home directory', status: 'ok', detail: 'duplicate' });
    expect(() => assessDoctorReport(duplicate, 0)).toThrow(
      '(distribution check Home directory): expected exactly one ok row | received: ok, ok'
    );
    const invalidStatus = report([]);
    invalidStatus.checks = invalidStatus.checks.map((row) => ({ ...row, status: 'unexpected' }));
    expect(() => assessDoctorReport(invalidStatus, 0)).toThrow('"status":"unexpected"');
  });

  test('fails closed for new failures and library failures beyond an empty home', () => {
    for (const label of ['New check', 'Skills config', 'ChatGPT credentials', 'MCP server']) {
      expect(() => assessDoctorReport(report([label]), 1)).toThrow(label);
    }
    const library = report(['locations']);
    library.checks = library.checks.map((row) =>
      row.label === 'locations' ? { ...row, detail: '1 of 24 present, 0 writable' } : row
    );
    expect(() => assessDoctorReport(library, 1)).toThrow('locations');
  });
});
