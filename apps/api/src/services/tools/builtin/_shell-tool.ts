/**
 * Factory that turns a shell kind into a registered tool.
 * bash, zsh, and powershell share one schema and executor; only the
 * interpreter and copy differ, so they are built from this single source.
 */

import { clampIntegerSetting, getOptionalString, getRequiredString } from '../arg-parsing';
import type { RegisteredTool, ToolContext } from '../types';
import { normalizeStringList } from './_fs-utils';
import { runShellCommand, type ShellCommandResult, type ShellKind } from './_shell-exec';

export const SHELL_DEFAULT_TIMEOUT_MS = 15_000;
export const SHELL_MIN_TIMEOUT_MS = 1_000;
/** Capped at the registry's 30s per-tool budget so Bun kills the child first. */
export const SHELL_MAX_TIMEOUT_MS = 30_000;

export const SHELL_DEFAULT_MAX_OUTPUT_BYTES = 100_000;
export const SHELL_MIN_MAX_OUTPUT_BYTES = 1_000;
export const SHELL_MAX_MAX_OUTPUT_BYTES = 1_000_000;

interface ShellPresentation {
  label: string;
  description: string;
}

const PRESENTATION: Record<ShellKind, ShellPresentation> = {
  bash: { label: 'Bash', description: 'Bash' },
  zsh: { label: 'Zsh', description: 'Zsh' },
  powershell: { label: 'PowerShell', description: 'PowerShell' },
};

interface ShellToolSettings {
  timeoutMs: number;
  maxOutputBytes: number;
  /** Secret-shaped env vars forwarded to commands anyway (denylist exceptions). */
  allowedEnvVars: string[];
  /** Extra env vars always withheld from commands (denylist additions). */
  deniedEnvVars: string[];
}

/**
 * Builds a registered tool for the given shell kind.
 *
 * // Usage: registerTool(buildShellTool('bash'));
 */
export function buildShellTool(kind: ShellKind): RegisteredTool {
  const { label, description } = PRESENTATION[kind];
  return {
    definition: buildDefinition(kind, description),
    settings: buildSettings(label, description),
    execute: (args, context) => execute(kind, args, context),
  };
}

export function normalizeShellToolSettings(parameters: Record<string, unknown>): ShellToolSettings {
  return {
    timeoutMs: clampIntegerSetting(
      parameters.timeoutMs,
      SHELL_DEFAULT_TIMEOUT_MS,
      SHELL_MIN_TIMEOUT_MS,
      SHELL_MAX_TIMEOUT_MS
    ),
    maxOutputBytes: clampIntegerSetting(
      parameters.maxOutputBytes,
      SHELL_DEFAULT_MAX_OUTPUT_BYTES,
      SHELL_MIN_MAX_OUTPUT_BYTES,
      SHELL_MAX_MAX_OUTPUT_BYTES
    ),
    allowedEnvVars: normalizeStringList(parameters.allowedEnvVars),
    deniedEnvVars: normalizeStringList(parameters.deniedEnvVars),
  };
}

function execute(
  kind: ShellKind,
  args: Record<string, unknown>,
  context: ToolContext
): Promise<ShellCommandResult> {
  const command = getRequiredString(args.command, 'command');
  const cwd = getOptionalString(args.cwd);
  const settings = normalizeShellToolSettings(context.parameters);
  return runShellCommand({
    kind,
    command,
    ...(cwd ? { cwd } : {}),
    timeoutMs: settings.timeoutMs,
    maxOutputBytes: settings.maxOutputBytes,
    envPolicy: { allow: settings.allowedEnvVars, deny: settings.deniedEnvVars },
  });
}

function buildDefinition(kind: ShellKind, description: string) {
  return {
    name: kind,
    description:
      `Runs a command with the ${description} shell and returns its stdout, stderr, and exit ` +
      'code. Use this when the user asks to run a command, script, or terminal operation.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          minLength: 1,
          description: `Command to execute with ${description}.`,
        },
        cwd: {
          type: 'string',
          description: 'Optional working directory. Absolute path or one starting with ~.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  };
}

function buildSettings(label: string, description: string): RegisteredTool['settings'] {
  return {
    title: `${label} shell`,
    description: `Allows the AI to run commands with the ${description} shell.`,
    category: 'system',
    // Command execution is powerful; require explicit opt-in.
    enabledByDefault: false,
    canDisable: true,
    defaultParameters: {
      timeoutMs: SHELL_DEFAULT_TIMEOUT_MS,
      maxOutputBytes: SHELL_DEFAULT_MAX_OUTPUT_BYTES,
      allowedEnvVars: [],
      deniedEnvVars: [],
    },
    parameterDescriptors: [
      {
        name: 'timeoutMs',
        label: 'Timeout (ms)',
        description: 'Maximum time a command may run before it is killed.',
        type: 'number',
        required: true,
        defaultValue: SHELL_DEFAULT_TIMEOUT_MS,
        min: SHELL_MIN_TIMEOUT_MS,
        max: SHELL_MAX_TIMEOUT_MS,
      },
      {
        name: 'maxOutputBytes',
        label: 'Max output bytes',
        description: 'Upper bound on captured stdout/stderr per stream.',
        type: 'number',
        required: true,
        defaultValue: SHELL_DEFAULT_MAX_OUTPUT_BYTES,
        min: SHELL_MIN_MAX_OUTPUT_BYTES,
        max: SHELL_MAX_MAX_OUTPUT_BYTES,
      },
      {
        name: 'allowedEnvVars',
        label: 'Forwarded secret variables',
        description:
          'Exact environment variable names to pass through to commands even when they look ' +
          'like secrets (e.g. GITHUB_TOKEN). One per line. Leave empty to withhold every ' +
          'auto-detected secret.',
        type: 'string_list',
        required: false,
        defaultValue: [] as string[],
      },
      {
        name: 'deniedEnvVars',
        label: 'Blocked variables',
        description:
          'Exact environment variable names to always withhold from commands, on top of the ' +
          'auto-detected secrets. One per line.',
        type: 'string_list',
        required: false,
        defaultValue: [] as string[],
      },
    ],
  };
}
