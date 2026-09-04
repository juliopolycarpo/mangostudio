import { describe, expect, it } from 'bun:test';

import { parseClaudeCliSurface } from '../../../src/services/external-agents/claude/cli-surface';
import { CLAUDE_HELP_TEXT, CLAUDE_HELP_TEXT_2_1_260 } from '../../support/claude-help';

/**
 * Claude declares its model aliases and effort levels in prose, not in a
 * `(choices: …)` list, so these are the only two vocabularies this adapter
 * reads out of a sentence. The traps are all in the vendor's real phrasing and
 * every one of them is exercised against the committed 2.1.260 excerpt rather
 * than a tidied string.
 */
describe('the vocabularies Claude states in prose', () => {
  describe('model aliases', () => {
    it('reads the aliases the vendor advertises', () => {
      const surface = parseClaudeCliSurface(CLAUDE_HELP_TEXT_2_1_260);
      expect(surface.modelAliases).toEqual(new Set(['fable', 'opus', 'sonnet']));
    });

    it('does not mistake the apostrophe in "model\'s" for a quoted alias', () => {
      // The prose reads "… or a model's full name …". A scan for quoted tokens
      // over the whole block closes the apostrophe against the next quote and
      // yields "s full name (e.g. " as an alias, which would then reach argv.
      const surface = parseClaudeCliSurface(CLAUDE_HELP_TEXT_2_1_260);
      for (const alias of surface.modelAliases ?? []) {
        expect(alias).not.toContain(' ');
      }
    });

    it('offers the aliases only, not the full-name example beside them', () => {
      // `claude-fable-5` is the vendor's example of a *full name*, in its own
      // second "(e.g. …)" group. Listing it would advertise a specific model
      // this account may not have, which is a worse answer than offering the
      // three aliases the vendor says always resolve.
      const surface = parseClaudeCliSurface(CLAUDE_HELP_TEXT_2_1_260);
      expect(surface.modelAliases?.has('claude-fable-5')).toBe(false);
    });

    it('reports a build that states no aliases as absent rather than empty', () => {
      // 2.1.227's `--model` line is the bare "Model for the current session."
      // Absent keeps the composer exactly as it is today; an empty set would
      // be a catalog that offers nothing.
      const surface = parseClaudeCliSurface(CLAUDE_HELP_TEXT);
      expect(surface.modelAliases).toBeUndefined();
    });
  });

  describe('effort levels', () => {
    it('reads the bare parenthesised list', () => {
      const surface = parseClaudeCliSurface(CLAUDE_HELP_TEXT_2_1_260);
      expect(surface.effortLevels).toEqual(new Set(['low', 'medium', 'high', 'xhigh', 'max']));
    });

    it('reports a build without the option as absent', () => {
      const surface = parseClaudeCliSurface(CLAUDE_HELP_TEXT);
      expect(surface.effortLevels).toBeUndefined();
    });
  });

  it('leaves the vocabularies the parser already read untouched', () => {
    const surface = parseClaudeCliSurface(CLAUDE_HELP_TEXT_2_1_260);
    expect(surface.permissionModes).toEqual(
      new Set(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'])
    );
    expect(surface.flags.has('--permission-prompts')).toBe(true);
  });
});
