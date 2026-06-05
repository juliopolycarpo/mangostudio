/**
 * Built-in tool: zsh
 * Runs commands through the Zsh shell. Registered only when zsh is on PATH.
 */

import { registerTool } from '../registry';
import { buildShellTool } from './_shell-tool';

/** Registers this built-in tool. // Usage: register() */
export function register(): void {
  registerTool(buildShellTool('zsh'));
}
