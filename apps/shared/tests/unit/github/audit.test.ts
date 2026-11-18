import { describe, expect, it } from 'bun:test';

import { summarizeGhSubcommand } from '../../../src/github/audit';
import { GH_READ_OPERATIONS, GH_WRITE_OPERATIONS } from '../../../src/github/gh-operations';

describe('summarizeGhSubcommand', () => {
  it.each([
    ['read', GH_READ_OPERATIONS],
    ['write', GH_WRITE_OPERATIONS],
  ] as const)('names every %s operation the runtime allows', (side, operations) => {
    expect(operations.length).toBeGreaterThan(0);
    for (const operation of operations) {
      const [command, subcommand] = operation.split(' ');
      expect(
        summarizeGhSubcommand([command, subcommand, '--title', 'prose']),
        `(gh ${side} allowlist): expected \`gh ${operation}\` summarized as its two tokens | received: redacted`
      ).toEqual([command, subcommand]);
    }
  });

  it('keeps an operation on one side of the allowlist only', () => {
    const overlap = GH_READ_OPERATIONS.filter((operation) =>
      (GH_WRITE_OPERATIONS as readonly string[]).includes(operation)
    );
    expect(overlap, `expected no operation on both gh allowlists | received: ${overlap}`).toEqual(
      []
    );
  });

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
