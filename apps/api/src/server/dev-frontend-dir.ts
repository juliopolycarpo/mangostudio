/**
 * Seam between `dev-frontend.ts` (dev-only) and `start-server.ts` (part of the
 * compiled binary). Mirrors `frontend-fallback.ts`'s pattern: this module has no
 * dependency on the frontend workspace, so `start-server.ts` can read it
 * unconditionally. Only `apps/api/src/dev.ts` — never the binary entry —
 * populates it.
 *
 * It exists because `getDefaultFrontendDir()` resolves `apps/frontend/dist`
 * against `process.cwd()`, and Turbo runs the API's dev task with the cwd set to
 * `apps/api`, not the repo root.
 */

let devFrontendDir: string | null = null;

/** Point the server at a dev build of the frontend. */
export function setDevFrontendDir(dir: string): void {
  devFrontendDir = dir;
}

/** The dev frontend directory, or null outside `bun run dev`. */
export function getDevFrontendDir(): string | null {
  return devFrontendDir;
}
