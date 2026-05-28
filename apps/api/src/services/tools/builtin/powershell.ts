/**
 * Built-in tool: powershell
 * Runs commands through PowerShell. Registered only on Windows where it exists.
 */

import { registerTool } from '../registry';
import { isShellAvailable } from './_shell-exec';
import { buildShellTool } from './_shell-tool';

/** Registers this tool. Called at import time when available, or directly by tests. */
export function register(): void {
  registerTool(buildShellTool('powershell'));
}

// Self-register on import only when PowerShell exists (Windows only).
if (isShellAvailable('powershell')) register();
