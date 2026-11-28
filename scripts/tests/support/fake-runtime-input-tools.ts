// Named fakes for the runtime input digest: the tool chain and git, with no
// process spawned and no repository needed.

import type { GitPort } from '../../ci/runtime-input-digest';
import type { ToolOutput, ToolRunner } from '../../lib/runtime-input-digest';

/** The tool versions a Linux runner reports; the values are arbitrary but fixed. */
const FAKE_TOOL_OUTPUT: Readonly<Record<string, string>> = {
  'cargo --version': 'cargo 1.100.0 (3acc79c0c 2026-11-05)',
  'rustc -vV':
    'rustc 1.100.0 (0ef1bc386 2026-11-09)\nhost: x86_64-unknown-linux-gnu\nLLVM version: 22.1.0',
  'zig version': '0.15.2',
  'cargo zigbuild --version': 'cargo-zigbuild 0.24.1',
  'xcodebuild -version': 'Xcode 26.0\nBuild version 17A324',
};

/** Answers tool commands from {@link FAKE_TOOL_OUTPUT} and records every call. */
export class FakeToolRunner {
  readonly calls: string[] = [];

  constructor(private readonly outputs: Readonly<Record<string, string>> = FAKE_TOOL_OUTPUT) {}

  readonly run: ToolRunner = (command): ToolOutput => {
    const line = command.join(' ');
    this.calls.push(line);
    const stdout = this.outputs[line];
    if (stdout === undefined) return { exitCode: 127, stdout: '', stderr: `${line}: not found` };
    return { exitCode: 0, stdout: `${stdout}\n`, stderr: '' };
  };
}

/** A git checkout reduced to the three answers the digest asks for. */
export class FakeGit implements GitPort {
  readonly hashed: string[] = [];

  constructor(
    private readonly index: ReadonlyArray<{ path: string; blob: string; mode?: string }>,
    private readonly status: ReadonlyArray<{ status: string; path: string }> = [],
    private readonly worktreeBlobs: Readonly<Record<string, string>> = {}
  ) {}

  readonly indexListing = (): string =>
    this.index
      .map((entry) => `${entry.mode ?? '100644'} ${entry.blob} 0\t${entry.path}\0`)
      .join('');

  readonly worktreeStatus = (): string =>
    this.status.map((entry) => `${entry.status} ${entry.path}\0`).join('');

  readonly hashObject = (path: string): string => {
    this.hashed.push(path);
    const blob = this.worktreeBlobs[path];
    if (blob === undefined) throw new Error(`FakeGit: no worktree blob scripted for ${path}`);
    return blob;
  };
}

/** One tracked file per path, blob ids derived from the path so each differs. */
export function indexOf(paths: readonly string[]): Array<{ path: string; blob: string }> {
  return paths.map((path, position) => ({
    path,
    blob: (position + 1).toString(16).padStart(40, '0'),
  }));
}

/** Every path the digest needs to find in an index, one crate file each. */
export const MINIMAL_RUNTIME_TREE: readonly string[] = [
  'Cargo.toml',
  'Cargo.lock',
  'rust-toolchain.toml',
  '.cargo/config.toml',
  'apps/shared/src/runtime-contract/generated/catalog.json',
  'apps/shared/src/runtime-contract/generated/hub-catalog.json',
  'apps/shared/src/runtime-contract/generated/health.schema.json',
  'apps/shared/src/runtime-contract/generated/install-output.schema.json',
  'apps/shared/src/runtime-contract/generated/manifest.schema.json',
  'apps/shared/src/runtime-contract/generated/runtime-home.schema.json',
  'apps/shared/src/runtime-contract/generated/strings.json',
  'apps/shared/src/external-agents/login.json',
  '.github/actions/setup-zigbuild/action.yml',
  'crates/mango-protocol/src/lib.rs',
  'crates/mangostudio-runtime/src/main.rs',
  'crates/mangostudio-runtime-cold/src/lib.rs',
  'crates/mangostudio-runtime-contract/src/lib.rs',
  'crates/mangostudio-runtime-core/src/lib.rs',
  // Outside the digest on purpose.
  'crates/mangostudio-runtime/tests/it/layout.rs',
  'crates/mangostudio-launcher/src/main.rs',
  'README.md',
];
