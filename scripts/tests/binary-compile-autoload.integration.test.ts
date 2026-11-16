import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { binaryCompileFlags } from '../lib/build';

const PROBE_VARIABLE = 'COMPILED_AUTOLOAD_PROBE';
const DOTENV_VALUE = 'read-from-working-directory-dotenv';
const PRELOAD_MARKER = 'bunfig-preload-ran';

let scratch: string;
let startDirectory: string;
let entry: string;

function compile(name: string, flags: readonly string[]): string {
  const binary = join(scratch, process.platform === 'win32' ? `${name}.exe` : name);
  const result = Bun.spawnSync(
    [process.execPath, 'build', entry, '--compile', ...flags, '--outfile', binary],
    { stdout: 'pipe', stderr: 'pipe' }
  );
  expect(
    result.exitCode,
    `expected ${name} compilation to succeed; received ${result.stderr.toString()}`
  ).toBe(0);
  return binary;
}

/** Runs `binary` in a directory holding a `.env` and a `bunfig.toml`, with a clean environment. */
function runInConfiguredDirectory(binary: string): { stdout: string; stderr: string } {
  // The caller's environment minus the probe, so a variable set in the shell
  // running the tests cannot stand in for the one the `.env` file would supply.
  const { [PROBE_VARIABLE]: _inherited, ...inheritedEnvironment } = process.env;
  const result = Bun.spawnSync([binary], {
    cwd: startDirectory,
    env: { ...inheritedEnvironment, HOME: scratch, USERPROFILE: scratch },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return { stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'compiled-autoload-'));
  startDirectory = join(scratch, 'start-here');
  mkdirSync(startDirectory);
  writeFileSync(join(startDirectory, '.env'), `${PROBE_VARIABLE}=${DOTENV_VALUE}\n`);
  writeFileSync(join(startDirectory, 'preload.js'), `console.log('${PRELOAD_MARKER}');\n`);
  writeFileSync(join(startDirectory, 'bunfig.toml'), 'preload = ["./preload.js"]\n');
  entry = join(scratch, 'entry.ts');
  writeFileSync(entry, `console.log('probe=' + String(process.env.${PROBE_VARIABLE}));\n`);
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// The compiled hub's configuration has one parser, apps/api/src/lib/config.ts.
// A `.env` or `bunfig.toml` in whatever directory the hub is started from must
// not reach it.
describe('compiled binary configuration autoload', () => {
  // Without this the assertions below could pass because the fixture stopped
  // working, not because the flags did. `--trim` leaves `bunfig.toml` off unless
  // asked, so the control asks for it; `.env` is on by default.
  test('control: a binary compiled without the opt-outs reads both files', () => {
    const output = runInConfiguredDirectory(
      compile('autoload-control', ['--trim', '--compile-autoload-bunfig'])
    );

    expect(
      output.stdout,
      `expected the control binary to print probe=${DOTENV_VALUE} | received: ${output.stdout}`
    ).toContain(`probe=${DOTENV_VALUE}`);
    expect(
      output.stdout,
      `expected the control binary to print ${PRELOAD_MARKER} | received: ${output.stdout}`
    ).toContain(PRELOAD_MARKER);
  });

  test.each(['native', 'bytecode'] as const)(
    'the %s hub compile flags ignore the working directory .env and bunfig.toml',
    (mode) => {
      const flags = binaryCompileFlags('production', mode);
      const output = runInConfiguredDirectory(compile(`hub-${mode}`, flags));

      expect(
        output.stdout,
        `expected probe=undefined (no .env read) | received: ${output.stdout}`
      ).toContain('probe=undefined');
      expect(
        output.stdout,
        `expected no "${PRELOAD_MARKER}" line (no bunfig.toml read) | received: ${output.stdout}`
      ).not.toContain(PRELOAD_MARKER);
    }
  );
});
