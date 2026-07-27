import type { ResourceFormat, ResourceKind } from '@mangostudio/shared/library';
import type { FormatAdapter } from './types';

export function createVerbatimAdapter(kind: ResourceKind, format: ResourceFormat): FormatAdapter {
  return {
    kind,
    from: format,
    to: format,
    strategy: 'verbatim',
    lossy: false,
    adapt: async ({ content }) => ({
      ok: true,
      content,
      notes: [],
      requiresReview: false,
      lossy: false,
    }),
  };
}
