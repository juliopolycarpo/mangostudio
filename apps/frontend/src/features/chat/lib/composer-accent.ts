/**
 * Which identity colour the composer wears.
 *
 * The composer is the one surface that acts *as* the runner rather than as the
 * product, so its frame carries the runner's colour: the border, the status
 * line, the prompt mark, the caret and Send all read a single custom property
 * that this resolves from the chat's runner.
 *
 * A MangoStudio chat resolves to the mango token — the hue the composer has
 * always had — so the default is unchanged and only a chat handed to a vendor
 * CLI looks different.
 *
 * Returned as a `var()` reference rather than a literal colour so the value
 * keeps tracking the theme: every one of these tokens has a light-mode
 * override, and a resolved hex would freeze the dark one in place.
 */

import type { ChatRunnerConfiguration } from '@mangostudio/shared/chat';

/** The property `.composer-shell` and everything under it read. */
export const COMPOSER_ACCENT_PROPERTY = '--composer-accent';

const EXTERNAL_ACCENT_TOKENS: Readonly<Record<string, string>> = {
  codex: '--color-agent-codex',
  claude: '--color-agent-claude',
  cursor: '--color-agent-cursor',
};

export function composerAccent(runner?: ChatRunnerConfiguration): string {
  if (!runner || runner.kind === 'mangostudio') return 'var(--color-agent-mango)';
  // A target this bundle predates still gets a composer, in the neutral
  // harness colour rather than in MangoStudio's — whoever is running the turn,
  // it is not us.
  return `var(${EXTERNAL_ACCENT_TOKENS[runner.targetId] ?? '--color-agent-generic'})`;
}
