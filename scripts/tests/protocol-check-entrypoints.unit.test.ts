import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import {
  cpSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { createProtocolCheckCommand } from '../lib/check';
import { ROOT_DIR } from '../lib/config';
import { FixtureCommands } from './support/fixture-command';

const commands = new FixtureCommands();
const directories: string[] = [];
let tools = '';

beforeAll(async () => {
  tools = mkdtempSync(join(tmpdir(), 'protocol-check-tools-'));
  const extension = process.platform === 'win32' ? '.exe' : '';
  const turbo = join(tools, `turbo${extension}`);
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, 'support/fake-protocol-check-command.ts')],
    compile: { outfile: turbo, autoloadDotenv: false, autoloadBunfig: false },
  });
  expect(build.success, build.logs.map(String).join('\n')).toBe(true);
  const bun = join(tools, `bun${extension}`);
  linkSync(turbo, bun);
  const warmRecords = join(tools, 'warm-records');
  mkdirSync(warmRecords);
  for (const command of [
    [turbo, 'run'],
    [bun, './scripts/protocol/check-versions.ts'],
  ]) {
    const result = Bun.spawnSync(command, {
      env: { ...process.env, PROTOCOL_CHECK_RECORDS: warmRecords },
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  }
  rmSync(warmRecords, { recursive: true, force: true });
}, 60_000);

afterEach(async () => {
  await commands.settle();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

afterAll(() => {
  if (tools) rmSync(tools, { recursive: true, force: true });
});

async function runProtocolCli(entrypoint: string, args: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'protocol-check-cli-'));
  directories.push(root);
  mkdirSync(join(root, 'scripts'));
  cpSync(join(ROOT_DIR, 'scripts/lib'), join(root, 'scripts/lib'), { recursive: true });
  cpSync(join(ROOT_DIR, 'scripts/protocol'), join(root, 'scripts/protocol'), { recursive: true });
  symlinkSync(join(ROOT_DIR, 'node_modules'), join(root, 'node_modules'), 'junction');
  const records = join(root, 'records');
  mkdirSync(records);
  const ambient = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH')
  );
  const result = await commands.run(
    [process.execPath, `./scripts/protocol/${entrypoint}`, ...args],
    root,
    {
      ...ambient,
      PATH: `${tools}${delimiter}${process.env.PATH ?? ''}`,
      PROTOCOL_CHECK_RECORDS: records,
    }
  );
  const calls = readdirSync(records).map(
    (file) =>
      JSON.parse(readFileSync(join(records, file), 'utf8')) as { tool: string; args: string[] }
  );
  return { ...result, calls };
}

test('the public protocol CLI cannot skip typechecking through an undocumented argument', async () => {
  const result = await runProtocolCli('check.ts', ['--ts-only', '--skip-typecheck']);
  expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  const workspace = result.calls.filter((call) => call.tool === 'turbo');
  expect(workspace).toHaveLength(1);
  expect(workspace[0]?.args, 'public protocol checker must retain typecheck:with-deps').toContain(
    'typecheck:with-deps'
  );
});

test('root Check selects the ordinary or canonical-report supervised companion', () => {
  expect(createProtocolCheckCommand()).toEqual(['bun', './scripts/protocol/check.ts', '--ts-only']);
  expect(createProtocolCheckCommand(true)).toEqual([
    'bun',
    './scripts/protocol/check-ci-report.ts',
  ]);
});

test('the internal report companion omits only the delivered component typecheck', async () => {
  const ordinary = await runProtocolCli('check.ts', ['--ts-only']);
  const report = await runProtocolCli('check-ci-report.ts');
  expect(ordinary.exitCode, ordinary.stdout + ordinary.stderr).toBe(0);
  expect(report.exitCode, report.stdout + report.stderr).toBe(0);
  expect(report.calls.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual(
    ordinary.calls
      .map((call) => ({ ...call, args: call.args.filter((arg) => arg !== 'typecheck:with-deps') }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  );
  expect(report.calls).toHaveLength(7);
});

test('the internal report companion rejects arguments before starting commands', async () => {
  const result = await runProtocolCli('check-ci-report.ts', ['--unexpected']);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('expected no arguments; received ["--unexpected"]');
  expect(result.calls).toEqual([]);
});
