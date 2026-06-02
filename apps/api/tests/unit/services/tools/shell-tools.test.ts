import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  isShellAvailable,
  type ShellKind,
} from '../../../../src/services/tools/builtin/_shell-exec';
import {
  buildShellTool,
  normalizeShellToolSettings,
  SHELL_DEFAULT_MAX_OUTPUT_BYTES,
  SHELL_DEFAULT_TIMEOUT_MS,
  SHELL_MAX_TIMEOUT_MS,
  SHELL_MIN_TIMEOUT_MS,
} from '../../../../src/services/tools/builtin/_shell-tool';
import {
  clearRegistry,
  executeTool,
  getAllTools,
  getTool,
  registerTool,
} from '../../../../src/services/tools/registry';
import type { RegisteredTool, ToolContext } from '../../../../src/services/tools/types';

const hasBash = isShellAvailable('bash');
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
    expect(names).toEqual(['timeoutMs', 'maxOutputBytes', 'allowedEnvVars', 'deniedEnvVars']);
  });
});

describe('normalizeShellToolSettings', () => {
  it('falls back to defaults for missing values', () => {
    const settings = normalizeShellToolSettings({});
    expect(settings.timeoutMs).toBe(SHELL_DEFAULT_TIMEOUT_MS);
    expect(settings.maxOutputBytes).toBe(SHELL_DEFAULT_MAX_OUTPUT_BYTES);
  });

  it('falls back to defaults for non-numeric values', () => {
    const settings = normalizeShellToolSettings({ timeoutMs: 'soon', maxOutputBytes: null });
    expect(settings.timeoutMs).toBe(SHELL_DEFAULT_TIMEOUT_MS);
    expect(settings.maxOutputBytes).toBe(SHELL_DEFAULT_MAX_OUTPUT_BYTES);
  });

  it('clamps the timeout to its bounds', () => {
    expect(normalizeShellToolSettings({ timeoutMs: 1 }).timeoutMs).toBe(SHELL_MIN_TIMEOUT_MS);
    expect(normalizeShellToolSettings({ timeoutMs: 999_999 }).timeoutMs).toBe(SHELL_MAX_TIMEOUT_MS);
  });

  it('rounds fractional values before clamping', () => {
    expect(normalizeShellToolSettings({ timeoutMs: 5000.7 }).timeoutMs).toBe(5001);
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
});
