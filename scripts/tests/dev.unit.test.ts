import { describe, expect, test } from 'bun:test';

import { WORKSPACES } from '../lib/config';
import {
  createDevTask,
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

  test('leaves stdin at the runner default so the dev tree gets its own process group', () => {
    const devScript = readText('scripts/dev.ts');

    expect(devScript).toContain('runCommand(task.label, task.cmd, { cwd: task.cwd })');
    expect(
      devScript,
      'expected scripts/dev.ts to pass no stdin option | received a stdin override'
    ).not.toMatch(/stdin:/);
    expect(supervisionMode(undefined, 'linux', false)).toBe('group');
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
