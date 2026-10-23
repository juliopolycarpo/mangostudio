/**
 * Built-in tool: powershell
 * Runs commands through PowerShell; per-turn runtime capabilities control exposure.
 */

import { registerTool } from '../registry';
import { buildShellTool } from './_shell-tool';

/** Registers this built-in tool. // Usage: register() */
export function register(): void {
  registerTool(buildShellTool('powershell'));
}
