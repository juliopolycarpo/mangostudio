/**
 * Factory that turns a shell kind into a registered tool.
 * bash, zsh, and powershell share one schema and executor; only the
 * interpreter and copy differ, so they are built from this single source.
 */

import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { toolchainService } from '../../../modules/environments/application/toolchain-service';
import { getRuntimeClient } from '../../runtime-client';
import { clampIntegerSetting, getOptionalString, getRequiredString } from '../arg-parsing';
import {
  buildToolExecutionTimeoutDescriptor,
  TOOL_EXECUTION_TIMEOUT_SECONDS_DEFAULT,
  TOOL_EXECUTION_TIMEOUT_SECONDS_MAX,
  TOOL_EXECUTION_TIMEOUT_SECONDS_MIN,
  ToolExecutionTimedOutError,
} from '../execution-timeout';
import type { RegisteredTool, ToolContext } from '../types';
import {
  assertWorkdirContainment,
  normalizeStringList,
  resolveWorkdirRelativePath,
} from './_fs-utils';
import type { ShellCommandResult, ShellKind } from './_shell-exec';

export const SHELL_DEFAULT_TIMEOUT_SECONDS = TOOL_EXECUTION_TIMEOUT_SECONDS_DEFAULT;
export const SHELL_MIN_TIMEOUT_SECONDS = TOOL_EXECUTION_TIMEOUT_SECONDS_MIN;
export const SHELL_MAX_TIMEOUT_SECONDS = TOOL_EXECUTION_TIMEOUT_SECONDS_MAX;

export const SHELL_DEFAULT_MAX_OUTPUT_BYTES = 100_000;
const SHELL_MIN_MAX_OUTPUT_BYTES = 1_000;
const SHELL_MAX_MAX_OUTPUT_BYTES = 1_000_000;

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
  timeoutSeconds: number;
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
    timeoutSeconds: clampIntegerSetting(
      parameters.timeoutSeconds,
      SHELL_DEFAULT_TIMEOUT_SECONDS,
      SHELL_MIN_TIMEOUT_SECONDS,
      SHELL_MAX_TIMEOUT_SECONDS
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

async function execute(
  kind: ShellKind,
  args: Record<string, unknown>,
  context: ToolContext
): Promise<ShellCommandResult> {
  const command = getRequiredString(args.command, 'command');
  const requestedCwd = getOptionalString(args.cwd, 'cwd') ?? context.workdir;
  const settings = normalizeShellToolSettings(context.parameters);
  const runtime = await getRuntimeClient(context.userId, context.environmentId);
  const toolchain = await toolchainService.resolve(
    context.userId,
    context.environmentId ?? LOCAL_ENVIRONMENT_ID
  );
  const resolution = { ...context, paths: runtime.paths };
  // Spawn with the same resolved path that was validated, so `~` and relative
  // inputs cannot diverge between the containment check and the child process.
  // Relative input anchors to the chat workdir, matching the filesystem tools.
  const cwd = requestedCwd ? resolveWorkdirRelativePath(requestedCwd, resolution) : undefined;
  if (cwd) {
    assertWorkdirContainment(cwd, resolution);
  }
  const result = await runtime.shell.run(
    {
      kind,
      command,
      ...(cwd ? { cwd } : {}),
      timeoutMs: settings.timeoutSeconds * 1000,
      maxOutputBytes: settings.maxOutputBytes,
      envPolicy: { allow: settings.allowedEnvVars, deny: settings.deniedEnvVars },
      toolchain,
    },
    context.signal ? { signal: context.signal } : undefined
  );
  if (result.termination.kind === 'timed_out') {
    throw new ToolExecutionTimedOutError(
      `Command timed out after ${settings.timeoutSeconds} seconds.`
    );
  }
  if (result.termination.kind === 'aborted') {
    throw createShellAbortError(context.signal?.reason);
  }
  return result;
}

function createShellAbortError(reason: unknown): Error {
  if (reason instanceof Error && reason.name === 'AbortError') {
    return reason;
  }
  return new DOMException('Command aborted.', 'AbortError');
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
          description:
            'Absolute path, ~ path, or path relative to the chat working directory. Omit or pass null to run in the chat working directory.',
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
    requiredCapabilities: ['shell'],
    // The command runs in a child process, so there is no path list to snapshot
    // before the fact and nothing a checkpoint could restore afterwards.
    uncheckpointedWriteSource: 'shell',
    defaultParameters: {
      timeoutSeconds: SHELL_DEFAULT_TIMEOUT_SECONDS,
      maxOutputBytes: SHELL_DEFAULT_MAX_OUTPUT_BYTES,
      allowedEnvVars: [],
      deniedEnvVars: [],
    },
    managesOwnTimeout: true,
    parameterDescriptors: [
      buildToolExecutionTimeoutDescriptor(),
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
