import type { LibraryLocationId } from './schemas';

/**
 * Locations MangoStudio always reads, whatever the user has toggled.
 *
 * These two are its own directories. Disabling them would make the app blind to
 * the resources it is itself responsible for, so the setting simply does not
 * reach them.
 */
export const ALWAYS_ENABLED_LIBRARY_LOCATIONS: readonly LibraryLocationId[] = [
  'mango-skills',
  'mango-agents',
];

/**
 * Which locations the scanner may touch, given the user's per-location toggles.
 *
 * Lives in the contract rather than in the API because both sides need the same
 * answer: the server refuses to preview a write into a location it never
 * scanned, and the client must not offer one. Takes a plain record rather than
 * importing `LibraryLocationSettings`, which would make the app-settings module
 * and this one import each other.
 *
 * // Usage: const enabled = enabledLibraryLocations(libraryLocationsFor(settings));
 */
export function enabledLibraryLocations(
  settings: Readonly<Record<string, boolean>>
): ReadonlySet<LibraryLocationId> {
  const enabled = new Set(
    Object.entries(settings).flatMap(([id, value]) => (value ? [id as LibraryLocationId] : []))
  );
  for (const id of ALWAYS_ENABLED_LIBRARY_LOCATIONS) enabled.add(id);
  return enabled;
}
