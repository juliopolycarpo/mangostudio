// Test-only in-memory repository for the collectors: a named fake of "the
// tracked files and how to read them", so registry and LoC tests never touch
// the real checkout or depend on filesystem permissions.

export interface FakeRepository {
  readonly trackedFiles: readonly string[];
  readonly readText: (path: string) => Promise<string>;
  /** Paths read so far, in order. */
  readonly reads: readonly string[];
}

/**
 * Build a fake repository from `path -> contents`. A value of `Error` makes
 * that path unreadable (the read rejects with it), like an EACCES or a file
 * deleted from the worktree; reading an untracked path rejects too.
 * // Usage: makeFakeRepository({ 'a.ts': 'const a = 1;', 'b.ts': new Error('EACCES') })
 */
export const makeFakeRepository = (
  files: Readonly<Record<string, string | Error>>
): FakeRepository => {
  const reads: string[] = [];
  return {
    trackedFiles: Object.keys(files),
    reads,
    readText: (path) => {
      reads.push(path);
      const contents = files[path];
      if (contents === undefined) {
        return Promise.reject(new Error(`ENOENT: no such tracked file ${path}`));
      }
      if (contents instanceof Error) return Promise.reject(contents);
      return Promise.resolve(contents);
    },
  };
};

/** A small repository shaped like this one: JS workspaces, Rust crates, scripts/, prose. */
export const BASE_REPOSITORY_FILES: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({ name: '@x/root', workspaces: ['apps/*', 'packages/*'] }),
  'README.md': '# readme\n',
  'Cargo.toml': [
    '[workspace]',
    'resolver = "3"',
    'members = ["crates/alpha", "crates/beta"]',
    'exclude = ["crates/alpha/fuzz"]',
    '',
  ].join('\n'),
  'apps/api/package.json': JSON.stringify({ name: '@x/api' }),
  'apps/api/tsconfig.json': '{}',
  'apps/api/src/server.ts': 'export const a = 1;\n',
  'apps/api/tests/server.test.ts': 'import "./x";\n',
  'packages/cli/package.json': JSON.stringify({ name: 'mangostudio' }),
  'packages/cli/src/main.ts': 'export {};\n',
  'crates/alpha/Cargo.toml': '[package]\nname = "alpha-crate"\nversion = "0.1.0"\n',
  'crates/alpha/src/lib.rs': '// alpha\npub fn a() {}\n',
  'crates/alpha/fuzz/Cargo.toml': '[package]\nname = "alpha-fuzz"\nversion = "0.0.0"\n',
  'crates/alpha/fuzz/fuzz_targets/one.rs': 'fn main() {}\n',
  'crates/beta/Cargo.toml': '[package]\nname = "beta"\nversion = "0.1.0"\n',
  'crates/beta/src/lib.rs': 'pub fn b() {}\n',
  'scripts/tsconfig.json': '{}',
  'scripts/check.ts': 'export {};\n',
  'docs/guide.md': '# guide\n',
  '.github/workflows/ci.yml': 'name: ci\n',
  'spec/schema.json': '{}\n',
  'tests/browser/a.spec.ts': 'export {};\n',
};
