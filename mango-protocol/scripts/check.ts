/**
 * `bun run check`: Biome, dprint, TypeScript, the spec verifier, the schema
 * equality check, the fixture generators' staleness checks, rustfmt, Clippy,
 * `cargo doc` with warnings denied, Clippy again over the full feature
 * powerset (needs `cargo-hack`; skipped with a warning when it is not on
 * PATH) and, with both toolchains, the TypeScript/Rust round trip.
 *
 * Flags: `--skip-format` (no Biome/dprint), `--staged` (accepted for the
 * lefthook hook; the repo is small enough to always check everything),
 * `--ts-only`, `--rs-only`.
 */

import {
  exitWith,
  hasCargo,
  hasCargoHack,
  hasFlag,
  runParallel,
  task,
  warnNoCargo,
  warnNoCargoHack,
} from './lib';

const skipFormat = hasFlag('--skip-format');
const tsOnly = hasFlag('--ts-only');
const rsOnly = hasFlag('--rs-only');

const tasks = [];
if (!rsOnly) {
  if (!skipFormat) {
    tasks.push(task('biome', ['bunx', 'biome', 'check', '.']));
    tasks.push(task('dprint', ['bunx', 'dprint', 'check']));
  }
  tasks.push(task('tsc', ['bunx', 'tsc', '--noEmit', '-p', 'packages/protocol/tsconfig.json']));
  tasks.push(task('tsc:scripts', ['bunx', 'tsc', '--noEmit', '-p', 'scripts/tsconfig.json']));
  tasks.push(task('versions', ['bun', './scripts/check-versions.ts']));
  tasks.push(task('verify-spec', ['bun', './scripts/verify-spec.ts']));
  tasks.push(
    task('schema-equality', [
      'bun',
      './scripts/verify-schema-equality.ts',
      ...(tsOnly || !hasCargo() ? ['--ts-only'] : []),
    ])
  );
  tasks.push(task('fixtures:chunks', ['bun', './scripts/fixtures/generate-chunks.ts', '--check']));
  tasks.push(
    task('fixtures:ssh-argv', ['bun', './scripts/fixtures/generate-ssh-argv.ts', '--check'])
  );
  tasks.push(
    task('fixtures:catalog-example', [
      'bun',
      './scripts/fixtures/generate-catalog-example.ts',
      '--check',
    ])
  );
}
if (!tsOnly) {
  if (hasCargo()) {
    if (!skipFormat) tasks.push(task('rustfmt', ['cargo', 'fmt', '--all', '--', '--check']));
    tasks.push(
      task('clippy', [
        'cargo',
        'clippy',
        '--all-targets',
        '--all-features',
        '--locked',
        '--',
        '-D',
        'warnings',
      ])
    );
    tasks.push(
      task('doc', ['cargo', 'doc', '--no-deps', '--all-features', '--locked'], undefined, {
        RUSTDOCFLAGS: '-D warnings',
      })
    );
    if (hasCargoHack()) {
      tasks.push(
        task('feature-powerset', [
          'cargo',
          'hack',
          'clippy',
          '--feature-powerset',
          '--all-targets',
          '--locked',
          '--',
          '-D',
          'warnings',
        ])
      );
    } else {
      warnNoCargoHack();
    }
    if (!tsOnly && !rsOnly) tasks.push(task('roundtrip', ['bun', './scripts/verify-roundtrip.ts']));
  } else {
    warnNoCargo();
  }
}

exitWith(await runParallel(tasks));
