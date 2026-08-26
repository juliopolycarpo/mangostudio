/**
 * "Open that rail panel" as a channel, so surfaces outside the rail can point
 * at one.
 *
 * The rail's active panel is component state, and deliberately so — it is a
 * layout choice, not application data. But three callers need to *change* it
 * from outside: the command palette (the rail has no keyboard shortcut for
 * switching panels at all, so the palette is the accessible path), and the
 * Repository panel's branch chip, which is a deep link into the GitHub panel.
 *
 * A module-level channel rather than a prop chain, on the same reasoning as
 * `composer-draft-store`: threading a setter from `ChatPage` through the shell
 * into the rail moves a string sideways through four components that have no
 * other reason to know about it.
 *
 * Fire-and-forget on purpose. A request while no rail is mounted is dropped,
 * not queued — a palette command run from settings should not silently arm a
 * panel switch that fires whenever the user next opens a chat.
 */

import type { WorkspacePanelId } from '@mangostudio/shared/workspaces';

type RailPanelListener = (panelId: WorkspacePanelId) => void;

const listeners = new Set<RailPanelListener>();

/**
 * Asks the mounted rail to show a panel.
 *
 * @example
 * requestRailPanel('github');
 */
export function requestRailPanel(panelId: WorkspacePanelId): void {
  for (const listener of listeners) listener(panelId);
}

/**
 * Subscribes the rail to panel requests.
 *
 * @example
 * useEffect(() => onRailPanelRequest(selectPanel), [selectPanel]);
 */
export function onRailPanelRequest(listener: RailPanelListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
