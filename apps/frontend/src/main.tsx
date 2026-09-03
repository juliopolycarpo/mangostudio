/* global document */

import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { authClient } from './lib/auth-client';
import { setAuthNavigate } from './lib/auth-navigate';
import { queryClient } from './lib/query-client';
import { router } from './router';
import './index.css';
// Eager, not from `TerminalView.tsx` (which is lazy-loaded): a CSS file
// reachable only through a dynamic `import()` becomes a second stylesheet
// `build.ts` refuses to ship, because nothing in this bundler injects a
// `<link>` for a lazy chunk's own CSS the way a dev server would.
import '@xterm/xterm/css/xterm.css';

setAuthNavigate(() => {
  router.navigate({ to: '/login' });
});

function App() {
  const { data: session, isPending } = authClient.useSession();

  if (isPending) {
    return (
      <div className="min-h-screen bg-surface-dim flex items-center justify-center">
        <div className="w-6 h-6 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </div>
    );
  }

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
