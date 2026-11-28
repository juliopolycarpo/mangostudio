import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

/** Text between the parenthesis opening at `open` and its match, or undefined if unbalanced. */
function balancedArgument(source: string, open: number): string | undefined {
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === '(') depth++;
    else if (source[index] === ')' && --depth === 0) return source.slice(open + 1, index);
  }
  return undefined;
}

/**
 * Repo-relative files one Rust source reads at compile time outside its crate's
 * own `.rs` modules: `include_str!` / `include_bytes!` targets and, in a
 * `build.rs`, the `../` literals handed to `.join(...)`. Generated `OUT_DIR` files are
 * skipped. A target ending in `/` names a directory whose file name is appended
 * at run time.
 * @example
 * rustIncludeTargets('crates/a/src/x.rs', 'crates/a', 'include_str!("../data.json")');
 * // ['crates/a/data.json']
 */
export function rustIncludeTargets(file: string, crateRoot: string, source: string): string[] {
  const targets: string[] = [];
  const literals = (argument: string) =>
    [...argument.replace(/env!\("[A-Z_]+"\)/g, '').matchAll(/"([^"]*)"/g)]
      .map((match) => match[1])
      .join('');
  for (const match of source.matchAll(/include_(?:str|bytes)!\(/g)) {
    const argument = balancedArgument(source, match.index + match[0].length - 1);
    if (argument === undefined || argument.includes('OUT_DIR')) continue;
    const base = argument.includes('CARGO_MANIFEST_DIR') ? crateRoot : dirname(file);
    targets.push(normalize(join(base, literals(argument))));
  }
  if (file.endsWith('/build.rs')) {
    // Only joins that leave the crate are inputs; the rest name generated outputs.
    for (const match of source.matchAll(/\.join\(\s*"(\.\.\/[^"]+)"\s*\)/g)) {
      targets.push(normalize(join(crateRoot, match[1] as string)));
    }
  }
  return targets;
}

/**
 * Every include target under `crates/`, each mapped to the Rust source that reads it.
 * @example
 * collectRustIncludeTargets('/repo'); // Map { 'spec/schema/1/protocol.json' => 'crates/.../schema.rs' }
 */
export function collectRustIncludeTargets(root: string): Map<string, string> {
  const found = new Map<string, string>();
  const crateRootOf = (directory: string): string => {
    let current = directory;
    while (!existsSync(join(root, current, 'Cargo.toml'))) current = dirname(current);
    return current;
  };
  const walk = (directory: string): void => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'target' && entry.name !== 'node_modules') walk(path);
      } else if (entry.name.endsWith('.rs')) {
        const source = readFileSync(join(root, path), 'utf8');
        for (const target of rustIncludeTargets(path, crateRootOf(dirname(path)), source)) {
          found.set(target, path);
        }
      }
    }
  };
  walk('crates');
  return found;
}
