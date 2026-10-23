/**
 * Built-in tool: bash
 * Runs commands through Bash; per-turn runtime capabilities control exposure.
 */

import { registerTool } from '../registry';
import { buildShellTool } from './_shell-tool';

/** Registers this built-in tool. // Usage: register() */
export function register(): void {
  registerTool(buildShellTool('bash'));
}
