/* global document */

import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { StartupSpinner } from './components/layout/StartupSpinner';
import { authClient } from './lib/auth-client';
import { setAuthNavigate } from './lib/auth-navigate';
import { preloadStartupLocale } from './lib/locale-dictionaries';
import { queryClient } from './lib/query-client';
import { router } from './router';
import './index.css';
// Eager, not from `TerminalView.tsx` (which is lazy-loaded): a CSS file
// reachable only through a dynamic `import()` becomes a second stylesheet
// `build.ts` refuses to ship, because nothing in this bundler injects a
// `<link>` for a lazy chunk's own CSS the way a dev server would.
import '@xterm/xterm/css/xterm.css';

// Before the first render, so a non-English dictionary chunk downloads
// alongside the session request instead of after it.
void preloadStartupLocale();

setAuthNavigate(() => {
  router.navigate({ to: '/login' });
});

function App() {
  const { data: session, isPending } = authClient.useSession();

  if (isPending) return <StartupSpinner />;

  return (
    <RouterProvider
      router={router}
      context={{
        auth: {
          isAuthenticated: !!session?.user,
          user: session?.user ?? null,
          isPending: false,
        },
        queryClient,
      }}
    />
  );
}

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element #root not found');
createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
