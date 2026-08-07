/**
 * Every child process this hub spawns must hide its console window on
 * Windows, or the System32 `wsl.exe` stub problem (see `wsl-executable.ts`)
 * repeats itself for any other launcher: a flash of console for every command.
 *
 * Rather than trust each call site to remember `...HIDDEN_WINDOW`, this walks
 * the real source tree and asserts it. Precedent:
 * `apps/frontend/tests/unit/shared-browser-safety.test.ts`.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../../../..');
const API_SRC = join(REPO_ROOT, 'apps/api/src');

/** Names `node:child_process` exports that spawn a subprocess directly. */
const SPAWNING_EXPORTS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync']);

function sourceFilesUnder(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'))
    .map((entry) => join(directory, entry))
    .filter((path) => statSync(path).isFile());
}

/**
 * Local names bound to `node:child_process` spawning exports in this file,
 * following any `as` alias. A file that imports nothing from the module binds
 * none, so a coincidental local named `spawn` (a wrapper variable, a renamed
 * helper) is never mistaken for the real thing.
 */
function boundSpawnNames(source: string): string[] {
  const match = source.match(/import\s*{([^}]*)}\s*from\s*['"]node:child_process['"]/);
  if (!match?.[1]) return [];
  return match[1]
    .split(',')
    .map((member) => member.trim())
    .filter(Boolean)
    .flatMap((member) => {
      const [imported, alias] = member.split(/\s+as\s+/).map((part) => part.trim());
      if (!imported || !SPAWNING_EXPORTS.has(imported)) return [];
      return [alias || imported];
    });
}

/** Line numbers (1-based) of every spawn call site in a file. */
function spawnCallLines(source: string): number[] {
  const names = ['Bun\\.spawnSync', 'Bun\\.spawn', ...boundSpawnNames(source)];
  const pattern = new RegExp(`\\b(?:${names.join('|')})\\(`, 'g');
  const lines: number[] = [];
  for (const match of source.matchAll(pattern)) {
    lines.push(source.slice(0, match.index).split('\n').length);
  }
  return lines;
}

describe('every child-process spawn hides its console window on Windows', () => {
  const files = sourceFilesUnder(API_SRC);

  it('scans a set of files that is neither empty nor accidentally tiny', () => {
    // Guards the walk itself: a broken glob would make the check below pass
    // by looking at nothing at all.
    expect(files.length).toBeGreaterThan(50);
  });

  it('has HIDDEN_WINDOW in scope wherever it spawns a child process', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const callLines = spawnCallLines(source);
      if (callLines.length === 0) continue;

      if (!/\bHIDDEN_WINDOW\b/.test(source)) {
        const relative = file.slice(REPO_ROOT.length + 1);
        for (const line of callLines) {
          offenders.push(`${relative}:${line} spawns without HIDDEN_WINDOW in scope`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
