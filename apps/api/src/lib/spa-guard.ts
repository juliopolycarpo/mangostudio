/**
 * Returns true when the pathname should be served as the SPA index.html.
 * Used by the onError NOT_FOUND handler in index.ts and by integration tests.
 */
export function isSpaRoute(pathname: string): boolean {
  return !['/api', '/uploads', '/images', '/scalar', '/assets'].some(
    (root) => pathname === root || pathname.startsWith(`${root}/`)
  );
}
