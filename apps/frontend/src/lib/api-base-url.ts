/**
 * Resolves the API base URL for the current runtime environment.
 *
 * Priority:
 * 1. Explicit VITE_API_URL (via .env.production) — for split deployments
 * 2. Browser origin (window.location.origin) — for same-origin / standalone binary
 * 3. Fallback for non-browser environments (unit tests, SSR)
 */
export function getApiBaseUrl(): string {
  const explicit = import.meta.env.VITE_API_URL;
  if (explicit) return explicit.replace(/\/+$/, '');

  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }

  return 'http://localhost:3001';
}
