import type { LibraryLocationId, LibraryScope } from './schemas';

/**
 * Locations MangoStudio always reads, whatever the user has toggled.
 *
 * These two are its own directories. Disabling them would make the app blind to
 * the resources it is itself responsible for, so the setting simply does not
 * reach them. Both are home-scoped, so the override applies to `home` only:
 * forcing them on under another scope would enable a location that has no
 * definition there.
 */
export const ALWAYS_ENABLED_LIBRARY_LOCATIONS: readonly LibraryLocationId[] = [
  'mango-skills',
  'mango-agents',
];

/**
 * Which locations the scanner may touch at one scope, given the user's toggles.
 *
 * Lives in the contract rather than in the API because both sides need the same
 * answer: the server refuses to preview a write into a location it never
 * scanned, and the client must not offer one. Takes a plain nested record
 * rather than importing `LibraryLocationSettings`, which would make the
 * app-settings module and this one import each other.
 *
 * // Usage: const enabled = enabledLibraryLocations(libraryLocationsFor(settings), 'home');
 */
export function enabledLibraryLocations(
  settings: Readonly<Record<string, Readonly<Record<string, boolean>> | undefined>>,
  scope: LibraryScope
): ReadonlySet<LibraryLocationId> {
  const scoped = settings[scope] ?? {};
  const enabled = new Set(
    Object.entries(scoped).flatMap(([id, value]) => (value ? [id as LibraryLocationId] : []))
  );
  if (scope === 'home') {
    for (const id of ALWAYS_ENABLED_LIBRARY_LOCATIONS) enabled.add(id);
  }
  return enabled;
}
