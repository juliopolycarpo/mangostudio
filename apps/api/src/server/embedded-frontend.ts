/**
 * Registry for frontend assets compiled into the standalone binary.
 *
 * The binary build (`scripts/build.ts --binary`) generates an entry module
 * that imports every file in `apps/frontend/dist` with Bun's file loader and
 * registers the resulting embedded paths here before the CLI boots. Dev and
 * source runs never call `registerEmbeddedFrontend`, so the registry stays
 * null and the server keeps serving from the filesystem.
 */

/**
 * URL path (e.g. '/assets/index-abc.js') → embedded file path servable via Bun.file().
 *
 * `null` marks a file whose identity bytes the build left out and kept only as
 * precompressed copies; the server inflates its gzip copy for a client that
 * accepts no stored coding.
 */
export type EmbeddedFrontendFiles = Readonly<Record<string, string | null>>;

/** Codings a precompressed copy can be stored in. */
export type EmbeddedContentCoding = 'br' | 'gzip';

/**
 * Identity URL path → coding → embedded path of that file's precompressed copy.
 *
 * Kept apart from `EmbeddedFrontendFiles` on purpose: every key of that map is a
 * public route and a line in the doctor's file count, and a `.br` copy is
 * neither. Only files worth compressing appear here.
 */
export type EmbeddedFrontendEncodings = Readonly<
  Record<string, Readonly<Partial<Record<EmbeddedContentCoding, string>>>>
>;

/**
 * What the build measured about the identity bytes of a file it left out of the binary: their
 * length and strong `ETag`, taken from the original file. HEAD, conditional requests and the
 * decoded-body cache budget are answered from these without inflating anything.
 */
export interface EmbeddedIdentityInfo {
  /** Length of the original (inflated) file in bytes. */
  readonly bytes: number;
  /** The strong validator an identity response carries, quotes included. */
  readonly etag: string;
}

/** URL path of every `null` entry of `EmbeddedFrontendFiles` → what the build measured about it. */
export type EmbeddedFrontendIdentity = Readonly<Record<string, EmbeddedIdentityInfo>>;

/** Sentinel frontendDir recorded in server state when assets are embedded. */
export const EMBEDDED_FRONTEND_DIR = '<embedded>';

let embeddedFrontend: EmbeddedFrontendFiles | null = null;
let embeddedEncodings: EmbeddedFrontendEncodings = {};
let embeddedIdentity: EmbeddedFrontendIdentity = {};

/**
 * Register the embedded frontend manifest and, optionally, its precompressed copies and the
 * measurements of the files whose identity bytes were left out.
 * // Usage: registerEmbeddedFrontend(embeddedFrontend, embeddedFrontendEncodings, embeddedFrontendIdentity)
 */
export function registerEmbeddedFrontend(
  files: EmbeddedFrontendFiles,
  encodings: EmbeddedFrontendEncodings = {},
  identity: EmbeddedFrontendIdentity = {}
): void {
  embeddedFrontend = files;
  embeddedEncodings = encodings;
  embeddedIdentity = identity;
}

/** The embedded precompressed copies; empty when none were built or running from source. */
export function getEmbeddedFrontendEncodings(): EmbeddedFrontendEncodings {
  return embeddedEncodings;
}

/** Length and `ETag` of every file embedded without identity bytes; empty when there are none. */
export function getEmbeddedFrontendIdentity(): EmbeddedFrontendIdentity {
  return embeddedIdentity;
}

/** The embedded frontend manifest, or null when running from source. */
export function getEmbeddedFrontend(): EmbeddedFrontendFiles | null {
  return embeddedFrontend;
}

/** Test seam: clear the registry so the filesystem path can be exercised. */
export function resetEmbeddedFrontend(): void {
  embeddedFrontend = null;
  embeddedEncodings = {};
  embeddedIdentity = {};
}
