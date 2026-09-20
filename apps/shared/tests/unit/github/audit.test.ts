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

  it('drops a non-string entry rather than stringifying it', () => {
    expect(summarizeGhSubcommand([42, 'pr'])).toEqual(['pr']);
  });
});
