// Node built-ins only: the nightly tests published packages without installing
// the checkout's dependencies or a Bun toolchain. Keep doctor's complete report
// and exit status; judge distribution health separately from optional host tools.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const REQUIRED = [
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

// These rows describe software outside the published package. An empty home
// needs none of it to run the standalone hub and its sibling Rust runtime.
// Unknown failed rows remain fatal, including provider, skills and MCP checks.
const HOST_TOOLS = new Set([
  'Bun',
  'Node.js',
  'Git',
  'fnm',
  'nvm',
  'winget',
  'Claude Code',
  'Codex',
  'Cursor',
]);

/** Validate the CLI contract before classifying optional host findings. */
export function assessDoctorReport(report, exitCode) {
  if (!report || !Array.isArray(report.checks) || report.checks.length === 0) {
    throw new Error('doctor returned no checks');
  }
  for (const row of report.checks) {
    if (
      !row ||
      typeof row.label !== 'string' ||
      row.label.length === 0 ||
      !['ok', 'warn', 'fail'].includes(row.status) ||
      typeof row.detail !== 'string'
    ) {
      throw new Error('doctor returned an invalid check');
    }
  }
  const failed = report.checks.filter((row) => row.status === 'fail');
  const warnings = report.checks.filter((row) => row.status === 'warn');
  if (report.failures !== failed.length || report.warnings !== warnings.length) {
    throw new Error('doctor counters disagree with its checks');
  }
  const expectedExit = failed.length > 0 ? 1 : 0;
  if (exitCode !== expectedExit) {
    throw new Error(`doctor exited ${exitCode}; its report requires exit ${expectedExit}`);
  }
  for (const label of REQUIRED) {
    const rows = report.checks.filter((row) => row.label === label);
    if (rows.length !== 1 || rows[0].status !== 'ok') {
      throw new Error(`distribution check ${label} must appear once and be healthy`);
    }
  }
  const hostFailures = [];
  for (const row of failed) {
    if (
      HOST_TOOLS.has(row.label) ||
      (row.label === 'locations' && /^0 of \d+ present, 0 writable$/.test(row.detail))
    ) {
      hostFailures.push(row);
    } else {
      throw new Error(`distribution doctor failed: ${row.label}: ${row.detail}`);
    }
  }
  return { exitCode, hostFailures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [file, status] = process.argv.slice(2);
    if (!file || !/^(0|[1-9]\d*)$/.test(status ?? '')) {
      throw new Error(
        'Usage: node verify-distribution-doctor.mjs <report.json> <doctor-exit-code>'
      );
    }
    const raw = readFileSync(file, 'utf8');
    process.stdout.write(raw);
    const result = assessDoctorReport(JSON.parse(raw), Number(status));
    console.log(
      `\nDistribution doctor passed; doctor exit=${result.exitCode}, optional host failures=${result.hostFailures.length}.`
    );
    for (const row of result.hostFailures) {
      console.log(`Optional host prerequisite: ${row.label}: ${row.detail}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
