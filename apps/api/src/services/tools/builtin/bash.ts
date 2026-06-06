/**
 * Built-in tool: bash
 * Runs commands through the Bash shell. Registered only when bash is on PATH.
 */

import { registerTool } from '../registry';
import { buildShellTool } from './_shell-tool';

/** Registers this built-in tool. // Usage: register() */
export function register(): void {
  registerTool(buildShellTool('bash'));
}
