import { describe, expect, it } from 'bun:test';
import { normalizeExternalAgentEvent } from '../../../src/services/external-agents/normalization';

function commandsAvailable(commands: ReadonlyArray<{ name: string; description?: string }>) {
  return normalizeExternalAgentEvent({ type: 'commands_available', commands });
}

describe('normalizeExternalAgentEvent commands_available', () => {
  it('drops names containing whitespace', () => {
    // A name with an internal space or newline cannot round-trip through the
    // composer's own `/name` token boundary: `slashQueryAt` and
    // `applySlashCompletion` split on the first whitespace, so a catalog entry
    // like "review notes" would advertise a command the completion itself
    // truncates to "review", turning "notes" into an argument.
    const event = commandsAvailable([
      { name: 'review notes' },
      { name: 'review\tnotes' },
      { name: '  ' },
      { name: 'review' },
    ]);

    expect(event).toEqual({
      type: 'commands_available',
      commands: [{ name: 'review' }],
    });
  });

  it('keeps single-token names and their descriptions', () => {
    const event = commandsAvailable([{ name: 'review', description: 'Reviews the diff' }]);

    expect(event).toEqual({
      type: 'commands_available',
      commands: [{ name: 'review', description: 'Reviews the diff' }],
    });
  });
});

describe('normalizeExternalAgentEvent reasoning_started', () => {
  /**
   * This boundary's switch is exhaustive with no default, so a member missed
   * here does not fail loudly — it falls off the end and the event is lost
   * before it reaches the wire, silently, on every turn that opens a
   * reasoning block. `external-turn-live-vs-reload.test.ts` drives the shared
   * projections directly and would stay green regardless, because it never
   * crosses this boundary.
   */
  it('passes the event through unchanged, having no vendor text to bound', () => {
    expect(normalizeExternalAgentEvent({ type: 'reasoning_started' })).toEqual({
      type: 'reasoning_started',
    });
  });
});
