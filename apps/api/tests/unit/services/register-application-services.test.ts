import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ProviderType } from '@mangostudio/shared/types';
import {
  clearRegistry as clearProviders,
  listRegisteredProviderTypes,
} from '../../../src/services/providers/core/provider-registry';
import { registerApplicationServices } from '../../../src/services/register-application-services';
import { isShellAvailable, type ShellKind } from '../../../src/services/tools/builtin/_shell-exec';
import { clearRegistry as clearTools, getAllTools } from '../../../src/services/tools/registry';

const EXPECTED_PROVIDER_TYPES = [
  'anthropic',
  'deepseek',
  'gemini',
  'openai',
  'openai-compatible',
] as const satisfies readonly ProviderType[];

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

function resetRegistries(): void {
  clearProviders();
  clearTools();
}

function restoreRegistries(): void {
  resetRegistries();
  registerApplicationServices();
}

describe('registerApplicationServices', () => {
  beforeEach(() => {
    resetRegistries();
  });

  afterEach(() => {
    restoreRegistries();
  });

  it('registers providers and tools from one startup entrypoint', () => {
    registerApplicationServices();

    expect([...listRegisteredProviderTypes()].sort()).toEqual([...EXPECTED_PROVIDER_TYPES].sort());
    expect(
      getAllTools()
        .map((tool) => tool.definition.name)
        .sort()
    ).toEqual(expectedToolNames());
  });
});
