/**
 * Which machine the umbrella is describing.
 *
 * It lives in the URL rather than in component state so a link to "Node on the
 * WSL box" is a link, the browser's back button walks the environments you
 * looked at, and a re-check that lands after you switched cannot write its
 * answer into the tab you are now looking at.
 */

import type { Environment } from '@mangostudio/shared/environments';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEnvironmentEntitiesQuery } from './queries';

export interface EnvironmentScopeSearch {
  readonly environmentId?: string;
}

export interface EnvironmentScope {
  readonly environmentId: string;
  /** The row itself, once the list has loaded. */
  readonly environment: Environment | undefined;
  readonly environments: readonly Environment[];
  /** The picker is noise on a single-machine install, so it hides itself. */
  readonly hasChoice: boolean;
  /**
   * Whether this environment can answer at all. A runtime that does not
   * advertise probing is a different situation from a broken one: nothing is
   * wrong with the machine, it just will not say what is on it.
   */
  readonly permitsProbing: boolean;
  /** Absent until the runtime has handshaked at least once. */
  readonly isConnected: boolean;
  readonly select: (environmentId: string) => void;
}

/**
 * Route-level validation of the scope param, shared by every tab that has one
 * so the three cannot drift on what an unusable value falls back to.
 */
export function validateEnvironmentSearch(raw: Record<string, unknown>): EnvironmentScopeSearch {
  return typeof raw.environmentId === 'string' && raw.environmentId.length > 0
    ? { environmentId: raw.environmentId }
    : {};
}

export function useEnvironmentScope(): EnvironmentScope {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as EnvironmentScopeSearch;
  const { data } = useEnvironmentEntitiesQuery();
  const environments = data ?? [];
  const environmentId = search.environmentId ?? LOCAL_ENVIRONMENT_ID;
  const environment = environments.find((candidate) => candidate.id === environmentId);
  const manifest = environment?.status.manifest;

  return {
    environmentId,
    environment,
    environments,
    hasChoice: environments.length > 1,
    // Unknown reads as permitted: the list may not have loaded yet, and
    // greying out a working environment for a moment is worse than letting the
    // request answer for itself.
    permitsProbing: manifest ? manifest.features.probing : true,
    isConnected: environment?.status.state === 'connected',
    select: (nextEnvironmentId) => {
      void navigate({
        to: '.',
        search: (current: EnvironmentScopeSearch) => ({
          ...current,
          // `local` is the default, so it stays out of the URL entirely.
          ...(nextEnvironmentId === LOCAL_ENVIRONMENT_ID
            ? { environmentId: undefined }
            : { environmentId: nextEnvironmentId }),
        }),
        // Push so Back restores the machine the user was looking at before.
        replace: false,
      });
    },
  };
}
