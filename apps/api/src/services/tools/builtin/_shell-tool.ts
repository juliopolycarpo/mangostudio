/**
 * Factory that turns a shell kind into a registered tool.
 * bash, zsh, and powershell share one schema and executor; only the
 * interpreter and copy differ, so they are built from this single source.
 */

import { getOptionalString, getRequiredString } from '../arg-parsing';
import type { RegisteredTool, ToolContext } from '../types';
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
    timeoutMs: clampNumber(
      parameters.timeoutMs,
      SHELL_DEFAULT_TIMEOUT_MS,
      SHELL_MIN_TIMEOUT_MS,
      SHELL_MAX_TIMEOUT_MS
    ),
    maxOutputBytes: clampNumber(
      parameters.maxOutputBytes,
      SHELL_DEFAULT_MAX_OUTPUT_BYTES,
      SHELL_MIN_MAX_OUTPUT_BYTES,
      SHELL_MAX_MAX_OUTPUT_BYTES
    ),
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
    ],
  };
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), min), max);
}
