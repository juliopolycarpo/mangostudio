/**
 * Single source of truth for which providers and built-in tools the application
 * registers at startup. Shared across the registration unit tests so adding a
 * provider or tool only updates one expectation list.
 */

import type { ProviderType } from '@mangostudio/shared/types';
import { isShellAvailable, type ShellKind } from '../../src/services/tools/builtin/_shell-exec';

const EXPECTED_PROVIDER_TYPES = [
  'anthropic',
  'chatgpt',
  'cursor',
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
  'edit_file',
  'replace_range',
  'apply_patch',
  'create_file',
  'delete_file',
  'move_file',
  'list_directory',
  'glob',
  'grep',
  'delegate_to_agent',
  'skill',
  'ask_user_question',
  'todo_write',
  'todo_read',
] as const;

const SHELL_TOOL_NAMES = ['bash', 'zsh', 'powershell'] as const satisfies readonly ShellKind[];

/** Sorted tool names expected on this host (shell tools only when available). // Usage: expectedToolNames() */
export function expectedToolNames(): string[] {
  return [...REQUIRED_TOOL_NAMES, ...SHELL_TOOL_NAMES.filter(isShellAvailable)].sort();
}

/** Sorted provider types expected after registration. // Usage: expectedProviderTypes() */
export function expectedProviderTypes(): ProviderType[] {
  return [...EXPECTED_PROVIDER_TYPES].sort();
}
