import { describe, expect, test } from 'bun:test';

import { parseArgs } from '../lib/args';
import { WORKSPACES } from '../lib/config';
import {
  createDevTask,
  devStdinMode,
  LOCAL_RUNTIME_BUILD_COMMAND,
  planLocalRuntimeBuild,
  RUSTUP_INSTALL_COMMAND,
  selectDevWorkspaces,
} from '../lib/dev';
import { supervisionMode } from '../lib/process-tree';
import { readText } from './support/read-text';

describe('dev script', () => {
  test('keeps only dev-capable workspaces', () => {
    expect(selectDevWorkspaces(['api', 'shared'])).toEqual({
      runnableWorkspaces: ['api'],
      skippedWorkspaces: ['shared'],
    });
  });

  test('redirects an explicit --frontend request to api instead of dropping it', () => {
    expect(selectDevWorkspaces(['frontend'])).toEqual({
      runnableWorkspaces: ['api'],
      skippedWorkspaces: [],
    });
  });

  test('does not run api twice when both --api and --frontend are given', () => {
    expect(selectDevWorkspaces(['api', 'frontend'])).toEqual({
      runnableWorkspaces: ['api'],
      skippedWorkspaces: [],
    });
  });

  test.each([
    ['a plain run', [], false],
    ['--all', ['--all'], false],
    ['--api', ['--api'], false],
    ['--root', ['--root'], true],
    ['--all --root', ['--all', '--root'], true],
  ] as const)('%s reports a typed --root as %p', (_name, args, typed) => {
    expect(
      parseArgs({}, args).explicitRoot,
      `(dev): expected explicitRoot: ${typed} for arguments: [${args.join(' ')}]`
    ).toBe(typed);
  });

  test('warns about --root only when it was typed', () => {
    // A plain `bun run dev` selects the root by default; warning there told
    // the user to drop a flag they never passed.
    const devScript = readText('scripts/dev.ts');
    expect(devScript).toMatch(/if \(explicitRoot\) \{\s+warn\('Ignoring `--root` for `dev`\.'\);/);
    expect(devScript).not.toContain('includeRoot');
  });

  test('starts the api dev script from the workspace directory without Turbo', () => {
    expect(createDevTask('api')).toEqual({
      label: 'api:dev',
      cmd: ['bun', 'run', 'dev'],
      cwd: WORKSPACES.api.path,
    });
  });

  test('the api dev script is the watched server the task starts', () => {
    const manifest = JSON.parse(readText('apps/api/package.json')) as {
      scripts?: Record<string, string>;
    };

    expect(
      manifest.scripts?.dev,
      `(dev): expected the api manifest dev script | received: ${manifest.scripts?.dev}`
    ).toBe('bun run --watch src/dev.ts serve');
  });

  test.each([
    ['a terminal on stdin and stdout', true, true, 'inherit'],
    ['a pipe on stdout', true, false, 'ignore'],
    ['a pipe on stdin', false, true, 'ignore'],
    ['no terminal at all', false, false, 'ignore'],
  ] as const)('devStdinMode with %s is %s', (name, stdinIsTerminal, stdoutIsTerminal, expected) => {
    expect(
      devStdinMode(stdinIsTerminal, stdoutIsTerminal),
      `(devStdinMode): expected stdin mode: ${expected} for ${name} | received: ${devStdinMode(stdinIsTerminal, stdoutIsTerminal)}`
    ).toBe(expected);
  });

  test('passes the terminal-derived stdin mode to the dev task, not a fixed one', () => {
    const devScript = readText('scripts/dev.ts');

    expect(devScript).toContain('const stdin = devStdinMode(isatty(0), isatty(1));');
    expect(devScript).toContain('runCommand(task.label, task.cmd, { cwd: task.cwd, stdin })');
    expect(
      devScript,
      "(dev): expected scripts/dev.ts to pass no literal stdin mode | received: a literal 'inherit' or 'ignore' stdin"
    ).not.toMatch(/stdin:\s*'/);
  });

  test('supervises an inherited dev stdin directly and an ignored one as a group', () => {
    expect(supervisionMode(devStdinMode(true, true), 'linux', false)).toBe('direct');
    expect(supervisionMode(devStdinMode(false, false), 'linux', false)).toBe('group');
  });

  test('passes no env option, so the server sees the ambient environment', () => {
    // runCommand hands a child the caller's environment unless given `env`.
    const devScript = readText('scripts/dev.ts');
    expect(
      devScript,
      '(dev): expected scripts/dev.ts to pass runCommand no env option | received: an env: key'
    ).not.toMatch(/\benv:/);
  });

  test('no longer declares a Turbo dev task', () => {
    const turboConfig = readText('turbo.jsonc');

    expect(
      turboConfig,
      '(dev): expected turbo.jsonc to declare no dev task | received: a "dev" task entry'
    ).not.toMatch(/^\s*"dev"\s*:/m);
    expect(turboConfig).not.toContain('"persistent"');
    expect(turboConfig).not.toContain('"interruptible"');
  });

  test('keeps the TUI default for the build script that inherits the terminal', () => {
    expect(readText('turbo.jsonc')).toContain('"ui": "tui"');
    expect(readText('scripts/build-turbo.ts')).toContain("stdin: 'inherit'");
  });

  test('starts the dev servers through the runner, not through Turbo', () => {
    const devScript = readText('scripts/dev.ts');

    expect(devScript).toContain('runCommand');
    expect(devScript).toContain('createDevTask');
    expect(devScript).not.toContain('turbo');
    expect(devScript).not.toContain('runWorkspaceScript');
  });

  test('builds the Local runtime before the hub when cargo is present', () => {
    expect(planLocalRuntimeBuild({}, true)).toEqual({
      kind: 'build',
      command: ['cargo', 'build', '-p', 'mangostudio-runtime', '--locked'],
    });
  });

  test('names the rustup one-liner instead of starting a hub that cannot launch Local', () => {
    const plan = planLocalRuntimeBuild({}, false);

    expect(plan.kind).toBe('missing-cargo');
    expect(plan.kind === 'missing-cargo' && plan.message).toContain(RUSTUP_INSTALL_COMMAND);
    expect(RUSTUP_INSTALL_COMMAND).toBe(
      "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    );
  });

  test('leaves an explicitly chosen runtime binary alone, with or without cargo', () => {
    const env = { MANGOSTUDIO_RUNTIME_BINARY: ' /ci/mangostudio-runtime ' };

    expect(planLocalRuntimeBuild(env, false)).toEqual({
      kind: 'skip',
      reason: 'MANGOSTUDIO_RUNTIME_BINARY is set to /ci/mangostudio-runtime',
    });
    expect(planLocalRuntimeBuild(env, true).kind).toBe('skip');
    expect(planLocalRuntimeBuild({ MANGOSTUDIO_RUNTIME_BINARY: '  ' }, true).kind).toBe('build');
  });

  test('builds the runtime before the dev servers start', () => {
    const devScript = readText('scripts/dev.ts');

    expect(devScript.indexOf('planLocalRuntimeBuild(')).toBeGreaterThan(-1);
    expect(devScript.indexOf('planLocalRuntimeBuild(')).toBeLessThan(
      devScript.indexOf('createDevTask(workspace)')
    );
    expect(LOCAL_RUNTIME_BUILD_COMMAND).toEqual([
      'cargo',
      'build',
      '-p',
      'mangostudio-runtime',
      '--locked',
    ]);
  });
});
