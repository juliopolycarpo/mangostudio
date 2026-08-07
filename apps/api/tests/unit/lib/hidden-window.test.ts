/**
 * Every child process this hub spawns must hide its console window on
 * Windows, or the System32 `wsl.exe` stub problem (see `wsl-executable.ts`)
 * repeats itself for any other launcher: a flash of console for every command.
 *
 * Rather than trust each call site to remember `...HIDDEN_WINDOW`, this walks
 * the real source tree and asserts it at every call. Precedent:
 * `apps/frontend/tests/unit/shared-browser-safety.test.ts`.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../../../..');
const API_SRC = join(REPO_ROOT, 'apps/api/src');

/**
 * Names `node:child_process` exports that can launch a subprocess. All of them
 * accept `windowsHide`, so all of them are in scope — `exec` and `execSync` run
 * their command through `cmd.exe` on Windows and are the loudest of the set.
 */
const SPAWNING_EXPORTS = new Set([
  'spawn',
  'spawnSync',
  'execFile',
  'execFileSync',
  'exec',
  'execSync',
  'fork',
]);

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

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
      const local = alias || imported;
      // Interpolated into a RegExp below, so anything that is not a plain
      // identifier is dropped rather than trusted as a pattern.
      return IDENTIFIER.test(local) ? [local] : [];
    });
}

/** Index just past the closing quote of the string or template starting at `start`. */
function endOfString(source: string, start: number): number {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i += 1) {
    const char = source[i];
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (char === quote) return i;
  }
  return source.length - 1;
}

/**
 * The argument list of the call whose opening paren sits at `open`. Strings,
 * templates, and comments are skipped whole so a paren inside one cannot close
 * the span early and truncate the text searched for `HIDDEN_WINDOW`.
 */
function callArguments(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (char === '/' && source[i + 1] === '/') {
      const newline = source.indexOf('\n', i);
      if (newline === -1) break;
      i = newline;
      continue;
    }
    if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      i = endOfString(source, i);
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

interface SpawnCallSite {
  readonly line: number;
  readonly hidesWindow: boolean;
}

/**
 * Every spawn call site in a file, each paired with whether its own arguments
 * carry `HIDDEN_WINDOW`. `Bun.spawn` is matched with its receiver; a bare
 * bound name must not be preceded by a dot or word character, so `deps.spawn()`
 * (an injected wrapper that applies the flag itself) and `/re/.exec()` are not
 * mistaken for direct spawns.
 */
function spawnCallSites(source: string): SpawnCallSite[] {
  const alternatives = ['\\bBun\\.(?:spawnSync|spawn)'];
  const bound = boundSpawnNames(source);
  if (bound.length > 0) alternatives.push(`(?<![.\\w$])(?:${bound.join('|')})`);
  const pattern = new RegExp(`(?:${alternatives.join('|')})\\s*\\(`, 'g');

  const sites: SpawnCallSite[] = [];
  for (const match of source.matchAll(pattern)) {
    const open = match.index + match[0].length - 1;
    sites.push({
      line: source.slice(0, match.index).split('\n').length,
      hidesWindow: /\bHIDDEN_WINDOW\b/.test(callArguments(source, open)),
    });
  }
  return sites;
}

describe('every child-process spawn hides its console window on Windows', () => {
  const files = sourceFilesUnder(API_SRC);

  it('scans a set of files that is neither empty nor accidentally tiny', () => {
    // Guards the walk itself: a broken glob would make the check below pass
    // by looking at nothing at all.
    expect(files.length).toBeGreaterThan(50);
  });

  it('finds the spawn sites it is supposed to be guarding', () => {
    // Guards the scanner: a regex that stopped matching would also make the
    // check below pass by finding nothing to complain about.
    const total = files.reduce(
      (count, file) => count + spawnCallSites(readFileSync(file, 'utf8')).length,
      0
    );

    expect(total).toBeGreaterThan(5);
  });

  it('passes HIDDEN_WINDOW at every child-process call', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const site of spawnCallSites(source)) {
        if (site.hidesWindow) continue;
        const relative = file.slice(REPO_ROOT.length + 1);
        offenders.push(`${relative}:${site.line} spawns without HIDDEN_WINDOW`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('the spawn scanner itself', () => {
  const IMPORT = "import { spawn, exec as run } from 'node:child_process';\n";

  it('accepts a call that spreads HIDDEN_WINDOW', () => {
    const sites = spawnCallSites(`${IMPORT}spawn('git', args, { cwd, ...HIDDEN_WINDOW });`);

    expect(sites).toEqual([{ line: 2, hidesWindow: true }]);
  });

  it('rejects a call that only has HIDDEN_WINDOW elsewhere in the file', () => {
    // The hole in a file-level check: one correct call site used to vouch for
    // every other call in the same file.
    const source = `${IMPORT}spawn('a', [], { ...HIDDEN_WINDOW });\nspawn('b', [], { cwd });`;

    expect(spawnCallSites(source)).toEqual([
      { line: 2, hidesWindow: true },
      { line: 3, hidesWindow: false },
    ]);
  });

  it('follows an as-alias and covers exec', () => {
    expect(spawnCallSites(`${IMPORT}run('ls', { cwd });`)).toEqual([
      { line: 2, hidesWindow: false },
    ]);
  });

  it('ignores method calls that merely share a spawning name', () => {
    const source = `${IMPORT}const m = /x(y)/.exec(value);\nconst p = deps.spawn(argv);`;

    expect(spawnCallSites(source)).toEqual([]);
  });

  it('ignores a spawning name in a file that never imports it', () => {
    expect(spawnCallSites('const m = PATTERN.exec(line);\nexec(fn);')).toEqual([]);
  });

  it('does not let a paren inside a string end the argument span', () => {
    const source = `${IMPORT}spawn('sh', ['-c', 'f() { :; }'], { ...HIDDEN_WINDOW });`;

    expect(spawnCallSites(source)).toEqual([{ line: 2, hidesWindow: true }]);
  });

  it('does not credit a HIDDEN_WINDOW that belongs to the next call', () => {
    const source = `${IMPORT}spawn('a', []);\nspawn('b', [], { ...HIDDEN_WINDOW });`;

    expect(spawnCallSites(source)).toEqual([
      { line: 2, hidesWindow: false },
      { line: 3, hidesWindow: true },
    ]);
  });
});
