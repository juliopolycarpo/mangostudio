import { describe, expect, it } from 'bun:test';

import { qualifiesRustStudyCommand } from '../bench/rust-costs';
import type { NativeCommandReceipt } from '../lib/native-bun-qualification-process';

function settledStudyCommand(): NativeCommandReceipt {
  return {
    label: 'settled-study-command',
    command: ['cargo', 'metadata', '--locked'],
    environment: {},
    startedAt: '2026-10-23T00:00:00Z',
    finishedAt: '2026-10-23T00:00:01Z',
    durationMs: 1000,
    exitCode: 0,
    signal: null,
    timedOut: false,
    timeoutSeconds: 5,
    errors: [],
    log: 'study-command.log',
    settlement: {
      scope: 'observed descendants and command process group',
      pollIntervalMs: 20,
      rootObserved: true,
      observed: [],
      survivors: [],
      snapshotErrors: [],
      pollErrors: [],
      empty: true,
    },
  };
}

describe('Rust study command admission', () => {
  it('keeps a recovered generic command unqualified when any historical census failed', () => {
    const command = settledStudyCommand();
    const recovered = {
      ...command,
      settlement: {
        ...command.settlement,
        pollErrors: ['Error: named fake census timeout, superseded by terminal census'],
      },
    };
    expect(recovered.exitCode).toBe(0);
    expect(recovered.errors).toEqual([]);
    expect(recovered.settlement.empty).toBe(true);
    expect(recovered.settlement.snapshotErrors).toEqual([]);
    expect(qualifiesRustStudyCommand(recovered)).toBe(false);
    expect(qualifiesRustStudyCommand(command)).toBe(true);
  });

  it('also requires successful exit, no cancellation and an empty terminal scope', () => {
    const command = settledStudyCommand();
    expect(qualifiesRustStudyCommand({ ...command, exitCode: 1 })).toBe(false);
    expect(qualifiesRustStudyCommand({ ...command, timedOut: true })).toBe(false);
    expect(qualifiesRustStudyCommand({ ...command, canceled: true })).toBe(false);
    expect(qualifiesRustStudyCommand({ ...command, signal: 'SIGTERM' })).toBe(false);
    expect(qualifiesRustStudyCommand({ ...command, errors: ['named fake command error'] })).toBe(
      false
    );
    expect(
      qualifiesRustStudyCommand({
        ...command,
        settlement: { ...command.settlement, empty: false },
      })
    ).toBe(false);
    expect(
      qualifiesRustStudyCommand({
        ...command,
        settlement: { ...command.settlement, pollErrors: undefined },
      })
    ).toBe(true);
  });
});
