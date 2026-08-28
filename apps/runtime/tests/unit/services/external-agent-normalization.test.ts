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
