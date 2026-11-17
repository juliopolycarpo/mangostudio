import { createFileRoute } from '@tanstack/react-router';

import { preloadNamespaces } from '@/lib/locale-dictionaries';

export const Route = createFileRoute('/_authenticated/settings/general')({
  // The "run setup again" card on this page reads the `onboarding` namespace.
  loader: () => preloadNamespaces(['onboarding']),
});
