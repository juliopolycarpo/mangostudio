import { describe, expect, it } from 'bun:test';
import {
  buildMcpServerWildcard,
  buildMcpToolName,
  isMcpToolName,
  parseMcpToolName,
  toolNameMatches,
} from '../../../../src/services/mcp/tool-naming';

describe('mcp tool naming', () => {
  it('round-trips build and parse', () => {
    const name = buildMcpToolName('github-tools', 'create_issue');

    expect(name).toBe('mcp__github-tools__create_issue');
    expect(parseMcpToolName(name)).toEqual({
      serverSlug: 'github-tools',
      toolName: 'create_issue',
    });
  });

  it('keeps tool names containing double underscores intact', () => {
    // The slug charset has no underscores, so the FIRST `__` after the prefix
    // terminates the slug and the rest belongs to the tool name verbatim.
    expect(parseMcpToolName('mcp__srv__weird__tool__name')).toEqual({
      serverSlug: 'srv',
      toolName: 'weird__tool__name',
    });
  });

  it.each([
    'mcp____x', // empty slug
    'mcp__srv__', // empty tool name
    'mcp__srv', // no separator
    'mcp__UPPER__tool', // slug charset violation
    'mcp__-srv__tool', // leading dash
    'generate_image', // not namespaced at all
    'mcp__', // bare prefix
  ])('rejects hostile or malformed name %s', (name) => {
    expect(parseMcpToolName(name)).toBeNull();
  });

  it('detects the prefix without validating the rest', () => {
    expect(isMcpToolName('mcp__srv__tool')).toBe(true);
    expect(isMcpToolName('generate_image')).toBe(false);
  });
});

describe('toolNameMatches', () => {
  const name = buildMcpToolName('github', 'create_issue');

  it('matches exact names and the global wildcard', () => {
    expect(toolNameMatches(new Set([name]), name)).toBe(true);
    expect(toolNameMatches(new Set(['*']), name)).toBe(true);
    expect(toolNameMatches(new Set(['*']), 'generate_image')).toBe(true);
  });

  it('matches the per-server wildcard only for that server', () => {
    const allowlist = new Set([buildMcpServerWildcard('github')]);

    expect(toolNameMatches(allowlist, name)).toBe(true);
    expect(toolNameMatches(allowlist, buildMcpToolName('github', 'other_tool'))).toBe(true);
    expect(toolNameMatches(allowlist, buildMcpToolName('gitlab', 'create_issue'))).toBe(false);
    expect(toolNameMatches(allowlist, 'generate_image')).toBe(false);
  });

  it('never treats a non-mcp prefix collision as a wildcard hit', () => {
    expect(toolNameMatches(new Set([buildMcpServerWildcard('git')]), name)).toBe(false);
    expect(toolNameMatches(new Set(['mcp__github__*']), 'mcp__github-extra__tool')).toBe(false);
  });

  it('rejects names outside the allowlist', () => {
    expect(toolNameMatches(new Set(['generate_image']), name)).toBe(false);
    expect(toolNameMatches(new Set<string>(), name)).toBe(false);
  });
});
