import { createFileRoute } from '@tanstack/react-router';
import { safeRedirect } from '@/lib/safe-redirect';

export const Route = createFileRoute('/login')({
  // Sanitize the redirect target up-front so every reader gets a safe,
  // app-internal path; keep it optional so navigating to /login without a
  // target (logout, signup link) stays valid.
  validateSearch: (raw: Record<string, unknown>): { redirect?: string } => {
    if (typeof raw.redirect !== 'string') return {};
    return { redirect: safeRedirect(raw.redirect) };
  },
});
