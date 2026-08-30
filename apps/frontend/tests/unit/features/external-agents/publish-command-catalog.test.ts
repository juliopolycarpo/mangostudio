/**
 * Filing the catalog a turn's stream carried under the hub-catalog key.
 *
 * The interesting part is that the cold GET (`externalCommandCatalogQueryOptions`)
 * never refetches on its own — without this write, a chat opened after a turn
 * already announced plugin or skill commands still reads whatever the first
 * GET in the tab saw, for as long as the tab stays open.
 */

import { describe, expect, it } from 'bun:test';
import type { ExternalAgentCommand } from '@mangostudio/shared/external-agents';
import { QueryClient } from '@tanstack/react-query';
import {
  externalCommandCatalogKey,
  publishExternalCommandCatalog,
} from '@/features/external-agents/queries';

const ENVIRONMENT_ID = 'local';
const OTHER_ENVIRONMENT_ID = 'build-server';

const COMMANDS: readonly ExternalAgentCommand[] = [{ name: 'review' }, { name: 'plan' }];

function keyFor(environmentId: string) {
  return externalCommandCatalogKey('codex', environmentId);
}

/**
 * Annotated on the way out: `getQueryData` on a bare key is `unknown`, and
 * `bun-types` shapes `toEqual` against the *received* type — so an
 * unannotated read makes every expectation below a type error rather than an
 * assertion.
 */
function cachedFor(
  queryClient: QueryClient,
  environmentId: string
): { commands: readonly ExternalAgentCommand[] } | undefined {
  return queryClient.getQueryData<{ commands: readonly ExternalAgentCommand[] }>(
    keyFor(environmentId)
  );
}

describe('publishExternalCommandCatalog', () => {
  it('overwrites the cold GET a chat opened before this turn ran', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(keyFor(ENVIRONMENT_ID), { commands: [] });

    publishExternalCommandCatalog(queryClient, 'codex', ENVIRONMENT_ID, COMMANDS);

    expect(cachedFor(queryClient, ENVIRONMENT_ID)).toEqual({ commands: COMMANDS });
  });

  it('seeds an entry no GET has run for yet', () => {
    const queryClient = new QueryClient();

    publishExternalCommandCatalog(queryClient, 'codex', ENVIRONMENT_ID, COMMANDS);

    expect(cachedFor(queryClient, ENVIRONMENT_ID)).toEqual({ commands: COMMANDS });
  });

  it('leaves another (environment, target) alone', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(keyFor(OTHER_ENVIRONMENT_ID), { commands: [] });

    publishExternalCommandCatalog(queryClient, 'codex', ENVIRONMENT_ID, COMMANDS);

    expect(cachedFor(queryClient, OTHER_ENVIRONMENT_ID)).toEqual({ commands: [] });
  });

  it('does nothing for a turn with no target', () => {
    const queryClient = new QueryClient();

    publishExternalCommandCatalog(queryClient, null, ENVIRONMENT_ID, COMMANDS);

    expect(cachedFor(queryClient, ENVIRONMENT_ID)).toBeUndefined();
  });
});
