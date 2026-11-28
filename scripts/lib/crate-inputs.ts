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
