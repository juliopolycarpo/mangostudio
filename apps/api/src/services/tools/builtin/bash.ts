/**
 * Built-in tool: bash
 * Runs commands through the Bash shell. Registered only when bash is on PATH.
 */

import { registerTool } from '../registry';
import { isShellAvailable } from './_shell-exec';
import { buildShellTool } from './_shell-tool';

/** Registers this tool. Called at import time when available, or directly by tests. */
export function register(): void {
  registerTool(buildShellTool('bash'));
}

// Self-register on import only when the shell exists.
if (isShellAvailable('bash')) register();
