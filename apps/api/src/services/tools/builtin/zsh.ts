/**
 * Built-in tool: zsh
 * Runs commands through the Zsh shell. Registered only when zsh is on PATH.
 */

import { registerTool } from '../registry';
import { isShellAvailable } from './_shell-exec';
import { buildShellTool } from './_shell-tool';

/** Registers this tool. Called at import time when available, or directly by tests. */
export function register(): void {
  registerTool(buildShellTool('zsh'));
}

// Self-register on import only when the shell exists.
if (isShellAvailable('zsh')) register();
