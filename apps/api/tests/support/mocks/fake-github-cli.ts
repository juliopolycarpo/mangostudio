/**
 * A `gh` that answers from a table instead of a subprocess.
 *
 * The old seam — a shell-script `gh` shim on PATH pointed at
 * `createGhCli({ environment })` — stopped intercepting anything when the spawn
 * moved to the runtime. Substituting the facade itself is the replacement: it
 * is the same interface the routes consume, so a test exercises every layer
 * above it without a connection manager, a runtime, or a git checkout.
 */

import type {
  GhCommandId,
  GhCommandParams,
} from '../../../src/modules/github/domain/gh-command-registry';
import type {
  GhCommandResult,
  GhCommandTarget,
  GhRuntimeSelection,
  GithubCli,
} from '../../../src/modules/github/infrastructure/gh-cli';

/** One recorded invocation, for asserting what a route asked `gh` to do. */
export interface RecordedGhCall {
  readonly id: GhCommandId;
  readonly params: unknown;
  readonly cwd: string;
  readonly selection: GhRuntimeSelection;
}

export interface FakeGithubCliOptions {
  readonly available?: boolean;
  readonly authenticated?: boolean;
  /** Per-command stdout. A command with no entry answers with empty stdout. */
  readonly stdout?: Partial<Record<GhCommandId, string>>;
  /**
   * Per-command override, for the failures a plain stdout cannot express — a
   * `gh` that exits non-zero with prose on stderr, which is how every non-ok
   * state below `not-authenticated` is actually reported.
   */
  readonly respond?: Partial<
    Record<GhCommandId, (call: RecordedGhCall) => Promise<GhCommandResult> | GhCommandResult>
  >;
}

export class FakeGithubCli implements GithubCli {
  readonly calls: RecordedGhCall[] = [];

  constructor(private readonly options: FakeGithubCliOptions = {}) {}

  isAvailable = (_selection: GhRuntimeSelection): Promise<boolean> =>
    Promise.resolve(this.options.available ?? true);

  isAuthenticated = (_selection: GhRuntimeSelection): Promise<boolean> =>
    Promise.resolve(this.options.authenticated ?? true);

  run = <I extends GhCommandId>(
    id: I,
    params: GhCommandParams<I>,
    target: GhCommandTarget
  ): Promise<GhCommandResult> => {
    const call: RecordedGhCall = {
      id,
      params,
      cwd: target.cwd,
      selection: target.selection,
    };
    this.calls.push(call);

    const responder = this.options.respond?.[id];
    if (responder) return Promise.resolve(responder(call));
    return Promise.resolve({ stdout: this.options.stdout?.[id] ?? '', stderr: '', exitCode: 0 });
  };

  /** Every command id this fake was asked for, in order. */
  ids(): GhCommandId[] {
    return this.calls.map((call) => call.id);
  }
}
