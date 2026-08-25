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
 */

import type { ChatRunnerConfiguration } from '@mangostudio/shared/chat';
import { agentIdentityTokens, MANGO_IDENTITY } from '@/lib/agent-identity';

/** The property `.composer-shell` and everything under it read. */
export const COMPOSER_ACCENT_PROPERTY = '--composer-accent';

export function composerAccent(runner?: ChatRunnerConfiguration): string {
  if (!runner || runner.kind === 'mangostudio') return MANGO_IDENTITY.colorVar;
  return agentIdentityTokens(runner.targetId).colorVar;
}
