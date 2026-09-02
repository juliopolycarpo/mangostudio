import type { Messages } from '@mangostudio/shared/i18n';
import type { TerminalRefusalReason } from '@mangostudio/shared/terminal';

/**
 * Localizes why a terminal cannot be opened here, shared by the rail panel
 * and the `/terminal` page so the two surfaces never word a refusal
 * differently.
 *
 * @example
 * unavailableMessage(t, availability.reason ?? 'unavailable');
 */
export function unavailableMessage(t: Messages, reason: TerminalRefusalReason): string {
  switch (reason) {
    case 'disabled':
      return t.terminal.unavailable.disabled;
    case 'limit':
      return t.terminal.unavailable.limit;
    case 'not-isolated':
      return t.terminal.unavailable.notIsolated;
    case 'unavailable':
      return t.terminal.unavailable.unavailable;
    case 'disconnected':
      return t.terminal.unavailable.disconnected;
  }
}
