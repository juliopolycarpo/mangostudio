/**
 * Resolves whether a stdio MCP server's `command` can actually be spawned:
 * a bare name (`uvx`, `npx`) is looked up on `PATH`, while a path-like command
 * (`/usr/local/bin/server`, `./bin/run`) is checked directly. Used by doctor's
 * MCP section to catch the "works on my machine" ENOENT before a probe spawns.
 */

import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/** True when `command` resolves to an executable file. // Usage: commandResolvesOnPath('uvx') */
export function commandResolvesOnPath(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;

  // A path-like command bypasses PATH; check the file directly.
  if (isAbsolute(trimmed) || trimmed.includes('/') || trimmed.includes('\\')) {
    return isExecutableFile(trimmed);
  }

  return Bun.which(trimmed) !== null;
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
