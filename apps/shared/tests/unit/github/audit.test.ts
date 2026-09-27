import { describe, expect, it } from 'bun:test';
import { summarizeGhSubcommand } from '../../../src/github/audit';

describe('summarizeGhSubcommand', () => {
  it('summarizes an argv down to its subcommand, never its prose', () => {
    expect(
      summarizeGhSubcommand(['pr', 'create', '--title', 'Secret plan', '--body', 'x'])
    ).toEqual(['pr', 'create']);
  });

  it('keeps a one-token argv whole', () => {
    expect(summarizeGhSubcommand(['--version'])).toEqual(['--version']);
  });

  it.each([
    ['unpublished project notes', 'private operand'],
    ['pr', 'unpublished project notes'],
    [42, 'pr', 'create'],
    ['pr', null, 'create'],
    ['--version', 'private operand'],
    ['auth'],
  ])('omits an unrecognized or malformed operation: %j', (...args) => {
    expect(summarizeGhSubcommand(args)).toEqual([]);
  });
});
