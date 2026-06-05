import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  isShellAvailable,
  type ShellKind,
} from '../../../../src/services/tools/builtin/_shell-exec';
import { registerTools } from '../../../../src/services/tools/register-tools';
import { clearRegistry, getAllTools } from '../../../../src/services/tools/registry';

const REQUIRED_TOOL_NAMES = [
  'get_current_datetime',
  'generate_image',
  'read_file',
  'write_file',
  'list_directory',
  'glob',
  'grep',
  'delegate_to_agent',
] as const;

const SHELL_TOOL_NAMES = ['bash', 'zsh', 'powershell'] as const satisfies readonly ShellKind[];

function expectedToolNames(): string[] {
  return [...REQUIRED_TOOL_NAMES, ...SHELL_TOOL_NAMES.filter(isShellAvailable)].sort();
}

function registeredToolNames(): string[] {
  return getAllTools()
    .map((tool) => tool.definition.name)
    .sort();
}

function restoreTools(): void {
  clearRegistry();
  registerTools();
}

describe('registerTools', () => {
  beforeEach(() => {
    clearRegistry();
  });

  afterEach(() => {
    restoreTools();
  });

  it('registers all built-in tools available on this host', () => {
    registerTools();

    expect(registeredToolNames()).toEqual(expectedToolNames());
  });

  it('keeps tool registration idempotent', () => {
    registerTools();
    registerTools();

    expect(registeredToolNames()).toEqual(expectedToolNames());
  });
});
