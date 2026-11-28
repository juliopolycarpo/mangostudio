// Finds the files a stable Rust crate reads that live outside its own
// directory. A test uses it to prove the `rust` lane in scripts/lib/rust-lanes.ts
// fires when any of them changes, and the pass stamps of `bun run test --rust`
// hash every one of them (scripts/lib/rust-workspace-lane.ts). Nothing in CI
// imports it.
//
// Three shapes are recognised, all by scanning source text (a macro's
// expansion is not observable from outside `rustc`):
//   - `include_str!` / `include_bytes!` / `include!`, whose bare literal is
//     relative to the source file and whose `concat!(env!("CARGO_MANIFEST_DIR"), ..)`
//     literal is relative to the crate directory;
//   - `#[path = "..."]`, relative to the source file;
//   - a run-time read that joins a literal onto `env!("CARGO_MANIFEST_DIR")`
//     (`.join("../../x")` or `concat!(env!(..), "/../../x")`), which needs no
//     macro at all and is still an input of `cargo test`.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { toPosixPath } from './script-guards';

/** One file a crate reads from outside its own source file. */
export interface CrateInput {
  /** Source file that reads it, repository-relative. */
  readonly source: string;
  /** 1-based line of the read in `source`. */
  readonly line: number;
  /**
   * Repository-relative POSIX path. A trailing `/` means the source names a
   * directory and appends a name of its own (`concat!(.., "/../../spec/", $file)`).
   */
  readonly path: string;
}

const INCLUDE_CALL = /\binclude(?:_str|_bytes)?!\s*\(/g;
const PATH_ATTRIBUTE = /#\[path\s*=\s*"([^"]+)"\s*\]/g;
const MANIFEST_DIR = 'env!("CARGO_MANIFEST_DIR")';
// A literal directly after the manifest dir: `, "/../x"` (concat!) or `.join("../x")`.
const AFTER_MANIFEST_DIR = /^\)*\s*(?:,\s*|\.join\(\s*)"([^"\n]*)"/;

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/** The text between the parenthesis at `open` and its match, or the rest of `text`. */
function balancedArguments(text: string, open: number): string {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    if (text[index] === ')') depth -= 1;
    if (depth === 0) return text.slice(open + 1, index);
  }
  return text.slice(open + 1);
}

function stringLiterals(text: string): string[] {
  return [...text.matchAll(/"([^"\n]*)"/g)].map((match) => match[1] as string);
}

/**
 * Every out-of-file input one Rust source reads, as repository-relative paths.
 *
 * @param source Repository-relative path of the file (for reporting).
 * @param text The file's contents.
 * @param crateDir Repository-relative directory of the crate that owns it.
 *
 * @example
 * extractCrateInputs(
 *   'crates/x/src/a.rs',
 *   'const S: &str = include_str!("../../../spec/a.json");',
 *   'crates/x'
 * ); // [{ source: 'crates/x/src/a.rs', line: 1, path: 'spec/a.json' }]
 */
export function extractCrateInputs(source: string, text: string, crateDir: string): CrateInput[] {
  const found = new Map<string, CrateInput>();
  const add = (index: number, base: string, literal: string): void => {
    const path = toPosixPath(join(base, literal.replace(/^\/+/, ''))).replace(/\/+$/, '');
    const trailing = /[\\/]$/.test(literal) ? '/' : '';
    found.set(path + trailing, { source, line: lineOf(text, index), path: path + trailing });
  };

  const includeSpans: Array<[number, number]> = [];
  for (const match of text.matchAll(INCLUDE_CALL)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const args = balancedArguments(text, open);
    includeSpans.push([open, open + args.length]);
    // OUT_DIR names a generated file, not a checked-in input.
    if (args.includes('OUT_DIR')) continue;
    const literals = stringLiterals(args).filter((literal) => literal !== 'CARGO_MANIFEST_DIR');
    if (literals.length === 0) continue;
    const base = args.includes('CARGO_MANIFEST_DIR') ? crateDir : dirname(source);
    add(open, base, literals.join(''));
  }

  for (const match of text.matchAll(PATH_ATTRIBUTE)) {
    add(match.index ?? 0, dirname(source), match[1] as string);
  }

  let from = 0;
  for (;;) {
    const at = text.indexOf(MANIFEST_DIR, from);
    if (at === -1) break;
    from = at + MANIFEST_DIR.length;
    const inInclude = includeSpans.some(([start, end]) => at > start && at < end);
    if (inInclude) continue;
    const literal = AFTER_MANIFEST_DIR.exec(text.slice(from))?.[1];
    if (literal) add(at, crateDir, literal);
  }
  return [...found.values()].sort((left, right) => left.path.localeCompare(right.path));
}

/** `//` and `///` lines: a macro named in a comment reads nothing. */
function withoutLineComments(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.trimStart().startsWith('//') ? '' : line))
    .join('\n');
}

/**
 * Paths a build script reaches by joining a literal onto its crate directory
 * (`manifest.join("../../apps/x.json")`), which no `include_str!` scan sees:
 * every string literal containing `../`, resolved from the crate directory.
 *
 * @example
 * extractBuildScriptInputs(
 *   'crates/x/build.rs',
 *   'let a = manifest.join("../../apps/a.json");',
 *   'crates/x'
 * ); // [{ source: 'crates/x/build.rs', line: 1, path: 'apps/a.json' }]
 */
export function extractBuildScriptInputs(
  source: string,
  text: string,
  crateDir: string
): CrateInput[] {
  const found = new Map<string, CrateInput>();
  const code = withoutLineComments(text);
  for (const match of code.matchAll(/"([^"\n]*\.\.\/[^"\n]*)"/g)) {
    const path = toPosixPath(join(crateDir, (match[1] as string).replace(/^\/+/, '')));
    found.set(path, { source, line: lineOf(code, match.index ?? 0), path });
  }
  return [...found.values()].sort((left, right) => left.path.localeCompare(right.path));
}

/** A read the scanner cannot turn into a path, so nothing proves it is hashed. */
export interface UnresolvedRead {
  readonly source: string;
  readonly line: number;
  /** What was found and why it cannot be resolved. */
  readonly reason: string;
}

/** The text between the brace at `open` and its match, or the rest of `text`. */
function balancedBraces(text: string, open: number): string {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    if (text[index] === '}') depth -= 1;
    if (depth === 0) return text.slice(open + 1, index);
  }
  return text.slice(open + 1);
}

/**
 * Include-family reads {@link extractCrateInputs} would skip without a word:
 * an `include!`/`include_str!`/`include_bytes!` with no string literal (a
 * variable or `$path` argument, unless it names `OUT_DIR`), a `macro_rules!`
 * whose body expands to one (its call sites are not resolved), and a `use` that
 * could rename one. Comments are ignored.
 *
 * @example
 * extractUnresolvedReads('crates/x/src/a.rs', 'const S: &str = include_str!(PATH);');
 * // [{ source: 'crates/x/src/a.rs', line: 1, reason: 'include_str! without a string literal …' }]
 */
export function extractUnresolvedReads(source: string, text: string): UnresolvedRead[] {
  const code = withoutLineComments(text);
  const found: UnresolvedRead[] = [];
  for (const match of code.matchAll(INCLUDE_CALL)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const args = balancedArguments(code, open);
    if (args.includes('OUT_DIR')) continue;
    const literals = stringLiterals(args).filter((literal) => literal !== 'CARGO_MANIFEST_DIR');
    if (literals.length === 0) {
      found.push({
        source,
        line: lineOf(code, match.index ?? 0),
        reason: `${match[0].replace(/\s*\($/, '')} without a string literal: expected a literal path | received: ${args.trim() || '(empty)'}`,
      });
    }
  }
  for (const match of code.matchAll(/\bmacro_rules!\s*(\w+)\s*\{/g)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    if (/\binclude(?:_str|_bytes)?!/.test(balancedBraces(code, open))) {
      found.push({
        source,
        line: lineOf(code, match.index ?? 0),
        reason: `macro_rules! ${match[1]} expands to an include-family macro: expected call sites resolved by hand | received: unresolved wrapper`,
      });
    }
  }
  for (const match of code.matchAll(/\buse\b[^;]*\binclude(?:_str|_bytes)?\b[^;]*;/g)) {
    found.push({
      source,
      line: lineOf(code, match.index ?? 0),
      reason: `import of an include-family macro: expected direct include_str!/include_bytes!/include! | received: ${match[0].replace(/\s+/g, ' ')}`,
    });
  }
  return found;
}

/**
 * Ways a build script can reach a file without a `../` literal that
 * {@link extractBuildScriptInputs} finds: walking up (`.parent()`,
 * `.ancestors()`), the process directory, listing or canonicalizing a
 * directory, and joining a literal that names a top-level repository
 * directory (`join("apps")`).
 *
 * @example
 * extractBuildScriptHazards('crates/x/build.rs', 'let a = dir.parent().unwrap();', ['apps']);
 * // [{ source: 'crates/x/build.rs', line: 1, reason: '.parent() …' }]
 */
export function extractBuildScriptHazards(
  source: string,
  text: string,
  repositoryRoots: readonly string[]
): UnresolvedRead[] {
  const code = withoutLineComments(text);
  const found: UnresolvedRead[] = [];
  const hazards: Array<[RegExp, string]> = [
    [/\.parent\s*\(\s*\)/g, '.parent()'],
    [/\.ancestors\s*\(\s*\)/g, '.ancestors()'],
    [/\bcurrent_dir\b/g, 'current_dir'],
    [/\bread_dir\b/g, 'read_dir'],
    [/\bcanonicalize\b/g, 'canonicalize'],
    [/\bCARGO_WORKSPACE_DIR\b/g, 'CARGO_WORKSPACE_DIR'],
  ];
  for (const [pattern, name] of hazards) {
    for (const match of code.matchAll(pattern)) {
      found.push({
        source,
        line: lineOf(code, match.index ?? 0),
        reason: `${name} reaches a path no literal names: expected a "../" literal resolved by the scan | received: ${name}`,
      });
    }
  }
  const roots = new RegExp(
    `^(?:\\./)?(?:${repositoryRoots.map(escapeForRegExp).join('|')})(?:/|$)`
  );
  if (repositoryRoots.length > 0) {
    for (const match of code.matchAll(/"([^"\n]+)"/g)) {
      if (roots.test(match[1] as string)) {
        found.push({
          source,
          line: lineOf(code, match.index ?? 0),
          reason: `literal names a top-level repository path: expected it resolved and hashed | received: ${JSON.stringify(match[1])}`,
        });
      }
    }
  }
  return found;
}

/** A `#[cfg(..)]` attribute that holds only when `test` is set (not `not(test)`). */
function isTestCfg(attribute: string): boolean {
  return (
    /^#\[cfg\(/.test(attribute.trim()) &&
    /\btest\b/.test(attribute) &&
    !/not\(\s*test/.test(attribute)
  );
}

/**
 * Whether the 1-based `line` of a rustfmt-formatted source sits inside a
 * top-level `mod` gated by `#[cfg(test)]` (or `cfg(all(test, ..))`). It looks
 * up for the nearest unindented item: a gated `mod` means yes; a closing brace
 * or any other item means no, so product code never passes by accident.
 *
 * @example
 * isInsideCfgTestModule('#[cfg(test)]\nmod tests {\n    const X: u8 = 1;\n}', 3); // true
 */
export function isInsideCfgTestModule(text: string, line: number): boolean {
  const lines = text.split('\n');
  for (let index = line - 1; index >= 0; index -= 1) {
    const current = lines[index] as string;
    if (
      current === '' ||
      /^\s/.test(current) ||
      current.startsWith('//') ||
      current.startsWith('#[')
    ) {
      continue;
    }
    if (!/^(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*\{/.test(current)) return false;
    for (let above = index - 1; above >= 0; above -= 1) {
      const attribute = lines[above] as string;
      if (attribute.startsWith('//')) continue;
      if (!attribute.startsWith('#[')) return false;
      if (isTestCfg(attribute)) return true;
    }
    return false;
  }
  return false;
}

/**
 * Whether `text` mounts the file `basename` as a module only under
 * `#[cfg(test)]`: `#[path = "<basename>"] mod ..;` or `mod <stem>;`, with a
 * test cfg among the attributes directly above. False when it is not mounted
 * by this text at all.
 *
 * @example
 * isMountedUnderCfgTest('#[cfg(test)]\nmod ts_compat_tests;', 'ts_compat_tests.rs'); // true
 */
export function isMountedUnderCfgTest(text: string, basename: string): boolean {
  const lines = text.split('\n');
  const stem = basename.replace(/\.rs$/, '');
  const mount = new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?mod\\s+${escapeForRegExp(stem)}\\s*;`);
  const pathAttribute = `#[path = "${basename}"]`;
  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index] as string;
    if (!mount.test(current) && !current.includes(pathAttribute)) continue;
    for (let above = index; above >= 0; above -= 1) {
      const attribute = lines[above] as string;
      if (above === index && !attribute.trimStart().startsWith('#[')) continue;
      if (!attribute.trimStart().startsWith('#[')) return false;
      if (isTestCfg(attribute)) return true;
    }
  }
  return false;
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One environment variable a crate reads while it compiles. */
export interface CompileTimeEnvRead {
  readonly source: string;
  readonly line: number;
  readonly name: string;
}

/**
 * The environment variables a source reads at compile time: `env!` and
 * `option_env!` anywhere, plus `env::var`/`env::var_os` in a build script (the
 * only place those run while compiling).
 *
 * @example
 * extractCompileTimeEnvReads('crates/x/src/a.rs', 'let v = env!("CARGO_PKG_VERSION");', false);
 * // [{ source: 'crates/x/src/a.rs', line: 1, name: 'CARGO_PKG_VERSION' }]
 */
export function extractCompileTimeEnvReads(
  source: string,
  text: string,
  buildScript: boolean
): CompileTimeEnvRead[] {
  const code = withoutLineComments(text);
  const pattern = buildScript
    ? /\b(?:option_env!|env!|env::var_os|env::var)\s*\(\s*"([^"\n]+)"/g
    : /\b(?:option_env!|env!)\s*\(\s*"([^"\n]+)"/g;
  return [...code.matchAll(pattern)].map((match) => ({
    source,
    line: lineOf(code, match.index ?? 0),
    name: match[1] as string,
  }));
}

function listRustSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // `fuzz` is the excluded nightly workspace, `target` is build output.
    if (entry.name === 'target' || entry.name === 'fuzz') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listRustSources(path));
    else if (entry.name.endsWith('.rs')) files.push(path);
  }
  return files;
}

/**
 * Every out-of-file input read by any stable crate under `<root>/crates`.
 *
 * @example
 * const inputs = scanCrateInputs(process.cwd());
 * inputs.map((input) => input.path); // ['Cargo.toml', 'spec/schema/1/protocol.json', ...]
 */
export function scanCrateInputs(root: string): CrateInput[] {
  const cratesDir = join(root, 'crates');
  const inputs: CrateInput[] = [];
  for (const crate of readdirSync(cratesDir, { withFileTypes: true })) {
    if (!crate.isDirectory()) continue;
    const crateDir = `crates/${crate.name}`;
    for (const file of listRustSources(join(cratesDir, crate.name))) {
      const source = toPosixPath(relative(root, file));
      inputs.push(...extractCrateInputs(source, readFileSync(file, 'utf8'), crateDir));
    }
  }
  return inputs;
}
