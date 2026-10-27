import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { catalogQueryOptions } from '@/hooks/use-model-catalog';

/**
 * Model ids mapped to the names the composer shows for them, for the transcript
 * to name who answered in the same words.
 *
 * Read from the catalog's cache and never fetched from here: the authenticated
 * shell already starts that request, a transcript that opens before it lands
 * simply shows stored ids until it does, and a chat of hundreds of rows must not
 * be the thing that asks the hub for it. The map is memoized on the catalog so
 * the rows it is threaded through, which are memoized themselves, keep their
 * identity between messages.
 *
 * @example
 * const modelNames = useModelDisplayNames();
 * modelNames.get('claude-sonnet-4-5-20250929') // => 'Claude Sonnet 4.5'
 */
export function useModelDisplayNames(): ReadonlyMap<string, string> {
  const { data } = useQuery({ ...catalogQueryOptions(), enabled: false });
  return useMemo(
    () => new Map((data?.allModels ?? []).map((model) => [model.modelId, model.displayName])),
    [data?.allModels]
  );
}
