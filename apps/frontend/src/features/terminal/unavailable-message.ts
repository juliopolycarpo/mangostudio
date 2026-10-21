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
    case 'runtime-unavailable':
      return t.terminal.unavailable.runtimeUnavailable;
    case 'runtime-update-required':
      return t.terminal.unavailable.runtimeUpdateRequired;
    case 'disconnected':
      return t.terminal.unavailable.disconnected;
  }
}

/**
 * The notice's title. A limit is not an outage: at the per-user cap the
 * environment works and the person's own open terminals are what stand in the
 * way, so it says so instead of calling the terminal unavailable.
 *
 * @example
 * <Callout title={unavailableTitle(t, reason)} />
 */
export function unavailableTitle(t: Messages, reason: TerminalRefusalReason): string {
  return reason === 'limit' ? t.terminal.unavailableTitleLimit : t.terminal.unavailableTitle;
}

/**
 * How a refusal is drawn. `disabled` and `not-isolated` are standing policy —
 * a fact the person cannot change from here — so they read as `info`. Every
 * other reason is something they can act on or wait out (close a terminal,
 * update the runtime, reconnect, try again), which `patterns.md` calls a
 * `warning`.
 *
 * @example
 * <Callout tone={unavailableTone(reason)} />
 */
export function unavailableTone(reason: TerminalRefusalReason): 'info' | 'warning' {
  return reason === 'disabled' || reason === 'not-isolated' ? 'info' : 'warning';
}
