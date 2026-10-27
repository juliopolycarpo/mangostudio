import type { ResourceFormat, ResourceKind } from '@mangostudio/shared/library';

import type { FormatAdapter } from './types';

export function createVerbatimAdapter(kind: ResourceKind, format: ResourceFormat): FormatAdapter {
  return {
    kind,
    from: format,
    to: format,
    strategy: 'verbatim',
    lossy: false,
    // eslint-disable-next-line @typescript-eslint/require-await -- The adapter preserves its Promise-returning interface contract.
    adapt: async ({ content }) => ({
      ok: true,
      content,
      notes: [],
      requiresReview: false,
      lossy: false,
    }),
  };
}
