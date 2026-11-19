/**
 * Records every `terminal.write` a hub makes to a runtime: when it was sent, how many bytes it
 * carried, and whether the runtime answered or refused it.
 *
 * The hub's socket route logs a refused write and moves on, so a test that only watches the
 * socket cannot tell "the runtime never got the input" from "the shell never answered it".
 */

import type { TerminalRuntimeClient } from '../../src/modules/terminals/domain/terminal-runtime-client';

export interface TerminalWriteTrace {
  /** The clock's reading at the call: `performance.now()` unless the tracer was given another. */
  readonly sentAtMs: number;
  /** Raw (decoded) input bytes the call carried. */
  readonly bytes: number;
  /** `pending` until the runtime answered; `rejected` carries `error`. */
  outcome: 'pending' | 'ok' | 'rejected';
  /** Milliseconds from the call to its answer; null while pending. */
  settledAfterMs: number | null;
  /** The refusal's message when `outcome` is `rejected`. */
  error?: string;
}

export interface TracedTerminalRuntime {
  readonly client: TerminalRuntimeClient;
  /** One entry per `terminal.write`, in call order. Entries settle in place. */
  readonly writes: readonly TerminalWriteTrace[];
}

/**
 * Wraps `client` so every `terminal.write` is recorded; every other call passes through.
 *
 * @example
 * const traced = traceTerminalWrites(runtime.client);
 * const service = createTerminalSessionService({ getRuntimeClient: () => Promise.resolve(traced.client) });
 * // later: describeTerminalWrites(traced.writes)
 */
export function traceTerminalWrites(
  client: TerminalRuntimeClient,
  now: () => number = () => performance.now()
): TracedTerminalRuntime {
  const writes: TerminalWriteTrace[] = [];
  const terminal: TerminalRuntimeClient['terminal'] = {
    ...client.terminal,
    write: async (params, options) => {
      const calledAt = now();
      const entry: TerminalWriteTrace = {
        sentAtMs: Math.round(calledAt),
        bytes: Buffer.from(params.data, 'base64').length,
        outcome: 'pending',
        settledAfterMs: null,
      };
      writes.push(entry);
      try {
        const result = await client.terminal.write(params, options);
        entry.outcome = 'ok';
        return result;
      } catch (error) {
        entry.outcome = 'rejected';
        entry.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        entry.settledAfterMs = Math.round(now() - calledAt);
      }
    },
  };
  return {
    client: {
      get manifest() {
        return client.manifest;
      },
      terminal,
      onClose: (listener) => client.onClose(listener),
    },
    writes,
  };
}

/**
 * One line of evidence for a failure message.
 *
 * @example
 * describeTerminalWrites([]); // 'writes=none'
 */
export function describeTerminalWrites(writes: readonly TerminalWriteTrace[]): string {
  return writes.length === 0 ? 'writes=none' : `writes=${JSON.stringify(writes)}`;
}
