/**
 * Returns true when the pathname should be served as the SPA index.html.
 * Used by the onError NOT_FOUND handler in index.ts and by integration tests.
 */
export function isSpaRoute(pathname: string): boolean {
  return (
    !pathname.startsWith('/api/') &&
    !pathname.startsWith('/uploads/') &&
    !pathname.startsWith('/scalar') &&
    !pathname.startsWith('/assets/')
  );
}
