/**
 * Built-in tool: powershell
 * Runs commands through PowerShell. Registered only on Windows where it exists.
 */

import { registerTool } from '../registry';
import { buildShellTool } from './_shell-tool';

/** Registers this built-in tool. // Usage: register() */
export function register(): void {
  registerTool(buildShellTool('powershell'));
}
