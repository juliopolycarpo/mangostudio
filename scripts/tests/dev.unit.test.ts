import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_DIR } from '../lib/config';
import {
  createTurboDevCommand,
  getDevCwd,
  selectDevWorkspaces,
  selectTurboDevUi,
} from '../lib/dev';

const readText = (relativePath: string): string =>
  readFileSync(join(ROOT_DIR, relativePath), 'utf8');

describe('dev script', () => {
  test('keeps only dev-capable workspaces', () => {
    expect(selectDevWorkspaces(['api', 'shared', 'frontend'])).toEqual({
      runnableWorkspaces: ['api', 'frontend'],
      skippedWorkspaces: ['shared'],
    });
  });

  test('creates one filtered Turbo invocation for selected workspaces', () => {
    expect(createTurboDevCommand(['api', 'frontend'], 'tui')).toEqual([
      'turbo',
      'run',
      'dev',
      '--ui=tui',
      '--env-mode=loose',
      '--filter=@mangostudio/api',
      '--filter=@mangostudio/frontend',
    ]);
  });

  test('can force stream output for non-interactive dev invocations', () => {
    expect(createTurboDevCommand(['api'], 'stream')).toEqual([
      'turbo',
      'run',
      'dev',
      '--ui=stream',
      '--env-mode=loose',
      '--filter=@mangostudio/api',
    ]);
  });

  test('runs dev servers in loose env mode so injected secrets survive', () => {
    expect(createTurboDevCommand(['api'], 'stream')).toContain('--env-mode=loose');
  });

  test('uses stream mode in CI and TUI locally', () => {
    expect(selectTurboDevUi({ CI: 'true' })).toBe('stream');
    expect(selectTurboDevUi({})).toBe('tui');
  });

  test('runs Turbo from the repository root', () => {
    expect(getDevCwd()).toBe(ROOT_DIR);
  });

  test('configures Turbo dev tasks for the interactive TUI', () => {
    const turboConfig = readText('turbo.jsonc');

    expect(turboConfig).toContain('"ui": "tui"');
    expect(turboConfig).toContain('"cache": false');
    expect(turboConfig).toContain('"persistent": true');
    expect(turboConfig).toContain('"interruptible": true');
  });

  test('delegates process orchestration to Turbo', () => {
    const devScript = readText('scripts/dev.ts');

    expect(devScript).toContain('runCommand');
    expect(devScript).toContain('createTurboDevCommand');
    expect(devScript).not.toContain('runWorkspaceScript');
    expect(devScript).not.toContain('Promise.all');
  });

  test('forwards the terminal so the Turbo TUI stays interactive', () => {
    expect(readText('scripts/dev.ts')).toContain("stdin: turboUi === 'tui' ? 'inherit' : 'ignore'");
  });
});
