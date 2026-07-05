/**
 * Registry for frontend assets compiled into the standalone binary.
 *
 * The binary build (`scripts/build.ts --binary`) generates an entry module
 * that imports every file in `apps/frontend/dist` with Bun's file loader and
 * registers the resulting embedded paths here before the CLI boots. Dev and
 * source runs never call `registerEmbeddedFrontend`, so the registry stays
 * null and the server keeps serving from the filesystem.
 */

/** URL path (e.g. '/assets/index-abc.js') → embedded file path servable via Bun.file(). */
export type EmbeddedFrontendFiles = Readonly<Record<string, string>>;

/** Sentinel frontendDir recorded in server state when assets are embedded. */
export const EMBEDDED_FRONTEND_DIR = '<embedded>';

let embeddedFrontend: EmbeddedFrontendFiles | null = null;

/** Register the embedded frontend manifest. // Usage: registerEmbeddedFrontend(embeddedFrontend) */
export function registerEmbeddedFrontend(files: EmbeddedFrontendFiles): void {
  embeddedFrontend = files;
}

/** The embedded frontend manifest, or null when running from source. */
export function getEmbeddedFrontend(): EmbeddedFrontendFiles | null {
  return embeddedFrontend;
}

/** Test seam: clear the registry so the filesystem path can be exercised. */
export function resetEmbeddedFrontend(): void {
  embeddedFrontend = null;
}
