import { createFileRoute } from '@tanstack/react-router';

import { preloadNamespaces } from '@/lib/locale-dictionaries';

export const Route = createFileRoute('/_authenticated/settings')({
  // The `settings` strings are not in the entry chunk. Loading them here, in the layout
  // every settings page nests under, runs alongside the lazy route chunk and finishes
  // before any of them commits, so no settings text ever renders as missing.
  loader: () => preloadNamespaces(['settings']),
});
