import { describe, expect, it } from 'bun:test';
import type { McpPortabilityDecisionInput } from '@mangostudio/shared/mcp';
import {
  assertUniquePostApplySlugs,
  findReplacementSlugBlocker,
} from '../../../../src/modules/mcp-servers/application/mcp-portability-slug-validation';
import { McpServerError } from '../../../../src/modules/mcp-servers/domain/mcp-server';

const FOO_OWNER = { id: 'foo-owner', name: 'Foo owner', slug: 'foo' };
const URL_MATCH = { id: 'url-match', name: 'URL match', slug: 'bar' };
const EXISTING = [FOO_OWNER, URL_MATCH];

function decisionMap(
  decisions: McpPortabilityDecisionInput[]
): Map<string, McpPortabilityDecisionInput> {
  return new Map(decisions.map((decision) => [decision.key, decision]));
}

describe('MCP portability slug validation', () => {
  it('identifies replacement targets that leave the incoming slug occupied', () => {
    expect(findReplacementSlugBlocker('foo', FOO_OWNER, EXISTING)).toBeUndefined();
    expect(findReplacementSlugBlocker('foo', URL_MATCH, EXISTING)).toEqual({
      slug: 'foo',
      holderName: 'Foo owner',
    });
    expect(findReplacementSlugBlocker('unused', URL_MATCH, EXISTING)).toBeUndefined();
  });

  it('rejects cross-entry decisions that produce the same slug', () => {
    let caught: unknown;
    try {
      assertUniquePostApplySlugs(
        [],
        [
          { key: 'first', name: 'First', slug: 'foo' },
          { key: 'second', name: 'Second', slug: 'foo' },
        ],
        decisionMap([
          { key: 'first', decision: 'add' },
          { key: 'second', decision: 'add' },
        ])
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(McpServerError);
    expect(caught).toMatchObject({ status: 422, code: 'VALIDATION' });
    expect((caught as Error).message).toContain('"First" and "Second"');
    expect((caught as Error).message).toContain('slug "foo"');
  });

  it('accepts a replacement that removes the slug owner and a distinct copy slug', () => {
    expect(() =>
      assertUniquePostApplySlugs(
        EXISTING,
        [
          { key: 'incoming', name: 'Incoming', slug: 'foo' },
          { key: 'copy', name: 'Copy', slug: 'bar', copySlug: 'bar-copy' },
        ],
        decisionMap([
          { key: 'incoming', decision: 'replace', targetServerId: 'foo-owner' },
          { key: 'copy', decision: 'copy' },
        ])
      )
    ).not.toThrow();
  });
});
