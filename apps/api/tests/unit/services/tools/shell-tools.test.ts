import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isShellAvailable,
  type ShellKind,
} from '../../../../src/services/tools/builtin/_shell-exec';
import {
  buildShellTool,
  normalizeShellToolSettings,
  SHELL_DEFAULT_MAX_OUTPUT_BYTES,
  SHELL_DEFAULT_TIMEOUT_SECONDS,
  SHELL_MAX_TIMEOUT_SECONDS,
  SHELL_MIN_TIMEOUT_SECONDS,
} from '../../../../src/services/tools/builtin/_shell-tool';
import { TOOL_EXECUTION_TIMEOUT_PARAM } from '../../../../src/services/tools/execution-timeout';
import {
  clearRegistry,
  executeTool,
  getAllTools,
  getTool,
  registerTool,
} from '../../../../src/services/tools/registry';
import { mergeToolSettings } from '../../../../src/services/tools/settings-policy';
import type { RegisteredTool, ToolContext } from '../../../../src/services/tools/types';

const hasBash = isShellAvailable('bash');
const outsideDir = tmpdir();
const SHELL_KINDS: ShellKind[] = ['bash', 'zsh', 'powershell'];

function snapshotRegistry(): RegisteredTool[] {
  return getAllTools().map((tool) => ({
    definition: { ...tool.definition },
    settings: { ...tool.settings, parameterDescriptors: [...tool.settings.parameterDescriptors] },
    execute: tool.execute,
    buildDefinition: tool.buildDefinition,
  }));
}

function restoreRegistry(snapshot: RegisteredTool[]): void {
  clearRegistry();
  for (const tool of snapshot) {
    registerTool(tool);
  }
}

function makeContext(parameters: Record<string, unknown> = {}): ToolContext {
  return { userId: 'u1', chatId: 'c1', parameters };
}

describe('buildShellTool', () => {
  it.each(SHELL_KINDS)('builds a registrable tool for %s', (kind) => {
    const tool = buildShellTool(kind);

    expect(tool.definition.name).toBe(kind);
    expect(tool.settings.category).toBe('system');
    expect(tool.settings.enabledByDefault).toBe(false);
    expect(tool.settings.canDisable).toBe(true);
    expect(tool.definition.parameters).toMatchObject({
      required: ['command'],
      additionalProperties: false,
    });
  });

  it('exposes timeout, output-size, and env-policy parameters', () => {
    const names = buildShellTool('bash').settings.parameterDescriptors.map((d) => d.name);
    expect(names).toEqual([
      TOOL_EXECUTION_TIMEOUT_PARAM,
      'maxOutputBytes',
      'allowedEnvVars',
      'deniedEnvVars',
    ]);
  });
});

describe('normalizeShellToolSettings', () => {
  it('falls back to defaults for missing values', () => {
    const settings = normalizeShellToolSettings({});
    expect(settings.timeoutSeconds).toBe(SHELL_DEFAULT_TIMEOUT_SECONDS);
    expect(settings.maxOutputBytes).toBe(SHELL_DEFAULT_MAX_OUTPUT_BYTES);
  });

  it('falls back to defaults for non-numeric values', () => {
    const settings = normalizeShellToolSettings({ timeoutSeconds: 'soon', maxOutputBytes: null });
    expect(settings.timeoutSeconds).toBe(SHELL_DEFAULT_TIMEOUT_SECONDS);
    expect(settings.maxOutputBytes).toBe(SHELL_DEFAULT_MAX_OUTPUT_BYTES);
  });

  it('clamps the timeout to its bounds', () => {
    expect(normalizeShellToolSettings({ timeoutSeconds: 1 }).timeoutSeconds).toBe(
      SHELL_MIN_TIMEOUT_SECONDS
    );
    expect(normalizeShellToolSettings({ timeoutSeconds: 999_999 }).timeoutSeconds).toBe(
      SHELL_MAX_TIMEOUT_SECONDS
    );
  });

  it('rounds fractional values before clamping', () => {
    expect(normalizeShellToolSettings({ timeoutSeconds: 45.7 }).timeoutSeconds).toBe(46);
  });

  it('defaults the env allow/deny lists to empty', () => {
    const settings = normalizeShellToolSettings({});
    expect(settings.allowedEnvVars).toEqual([]);
    expect(settings.deniedEnvVars).toEqual([]);
  });

  it('normalizes env allow/deny lists from arrays and newline strings', () => {
    const fromArray = normalizeShellToolSettings({ allowedEnvVars: [' GITHUB_TOKEN ', '', 'CI'] });
    expect(fromArray.allowedEnvVars).toEqual(['GITHUB_TOKEN', 'CI']);

    const fromString = normalizeShellToolSettings({ deniedEnvVars: 'HOME\n\nTMPDIR' });
    expect(fromString.deniedEnvVars).toEqual(['HOME', 'TMPDIR']);
  });
});

describe('mergeToolSettings legacy shell timeout migration', () => {
  it('migrates saved timeoutMs values to timeoutSeconds', () => {
    const merged = mergeToolSettings(buildShellTool('bash'), {
      enabled: true,
      parameters: { timeoutMs: 20_000, maxOutputBytes: 1000 },
    });
    expect(merged.parameters.timeoutSeconds).toBe(20);
    expect(merged.parameters).not.toHaveProperty('timeoutMs');
  });
});

describe('shell tool registration and execution', () => {
  let snapshot: RegisteredTool[];

  beforeEach(() => {
    snapshot = snapshotRegistry();
    clearRegistry();
    registerTool(buildShellTool('bash'));
  });

  afterEach(() => {
    restoreRegistry(snapshot);
  });

  it('registers the bash tool with expected metadata', () => {
    const tool = getTool('bash');
    expect(tool).toBeDefined();
    expect(tool?.settings.title).toBe('Bash shell');
  });

  it('stays disabled until explicitly enabled', async () => {
    let threw = false;
    try {
      await executeTool('bash', { command: 'echo hi' }, makeContext());
    } catch (error) {
      threw = true;
      expect((error as Error).message).toContain('disabled');
    }
    expect(threw).toBe(true);
  });

  it.skipIf(!hasBash)('executes a command when enabled', async () => {
    const result = (await executeTool('bash', { command: 'echo from-registry' }, makeContext(), {
      enabled: true,
      parameters: {},
    })) as { stdout: string; exitCode: number };

    expect(result.stdout.trim()).toBe('from-registry');
    expect(result.exitCode).toBe(0);
  });

  it.skipIf(!hasBash)('defaults command execution to the chat workdir', async () => {
    const result = (await executeTool(
      'bash',
      { command: 'pwd' },
      { ...makeContext(), workdir: tmpdir() },
      { enabled: true, parameters: {} }
    )) as { stdout: string };

    expect(result.stdout.trim()).toBe(tmpdir());
  });

  it.skipIf(!hasBash)('rejects a cwd outside the chat workdir when restricted', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'shell-workdir-'));
    try {
      let threw = false;
      try {
        await executeTool(
          'bash',
          { command: 'pwd', cwd: outsideDir },
          {
            ...makeContext(),
            workdir,
            workdirPolicy: { root: workdir, restricted: true },
          },
          { enabled: true, parameters: {} }
        );
      } catch (error) {
        threw = true;
        expect((error as Error).message).toContain('outside the chat working directory');
      }
      expect(threw).toBe(true);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasBash)('throws when the command argument is missing', async () => {
    let threw = false;
    try {
      await executeTool('bash', {}, makeContext(), { enabled: true, parameters: {} });
    } catch (error) {
      threw = true;
      expect((error as Error).message).toContain('command');
    }
    expect(threw).toBe(true);
  });

  it.skipIf(!hasBash)(
    'throws a timeout error when the command exceeds its budget',
    async () => {
      let threw = false;
      try {
        await executeTool('bash', { command: 'sleep 10' }, makeContext(), {
          enabled: true,
          parameters: {
            timeoutSeconds: 5,
            maxOutputBytes: 10_000,
            allowedEnvVars: [],
            deniedEnvVars: [],
          },
        });
      } catch (error) {
        threw = true;
        expect((error as Error).message.toLowerCase()).toContain('timed out');
      }
      expect(threw).toBe(true);
    },
    15_000
  );

  it.skipIf(!hasBash)(
    'throws an abort error instead of a timeout when cancelled early',
    async () => {
      const controller = new AbortController();
      const run = executeTool(
        'bash',
        { command: 'sleep 10' },
        { ...makeContext({ timeoutSeconds: 30 }), signal: controller.signal },
        { enabled: true, parameters: { timeoutSeconds: 30 } }
      );
      setTimeout(() => controller.abort(), 300);

      let threw = false;
      try {
        await run;
      } catch (error) {
        threw = true;
        expect((error as Error).name).toBe('AbortError');
        expect((error as Error).message.toLowerCase()).not.toContain('timed out');
      }
      expect(threw).toBe(true);
    },
    15_000
  );
});
