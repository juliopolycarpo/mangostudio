import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SafeFetchDeps, SafeFetchError, safeFetchBytes } from '../../../lib/safe-fetch';

const MAX_INSTALLER_REDIRECTS = 5;

interface InstallerDownloadRequest {
  readonly url: string;
  readonly minBytes: number;
  readonly maxBytes: number;
}

export interface InstallerArtifact {
  readonly path: string;
  readonly url: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  cleanup(): Promise<void>;
}

export interface InstallerDownloader {
  download(
    request: InstallerDownloadRequest,
    options?: { signal?: AbortSignal }
  ): Promise<InstallerArtifact>;
}

export class InstallerDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallerDownloadError';
  }
}

interface InstallerDownloadDeps extends SafeFetchDeps {
  readonly createTempDir: () => Promise<string>;
  readonly writeFile: (path: string, data: Uint8Array) => Promise<void>;
  readonly removeDir: (path: string) => Promise<void>;
}

const defaultDeps: InstallerDownloadDeps = {
  fetch,
  createTempDir: () => mkdtemp(join(tmpdir(), 'mangostudio-installer-')),
  writeFile: (path, data) => writeFile(path, data),
  removeDir: (path) => rm(path, { recursive: true, force: true }),
};

function assertSizeBounds(request: InstallerDownloadRequest): void {
  if (
    !Number.isSafeInteger(request.minBytes) ||
    !Number.isSafeInteger(request.maxBytes) ||
    request.minBytes < 1 ||
    request.maxBytes < request.minBytes
  ) {
    throw new InstallerDownloadError('Installer size bounds are invalid.');
  }
}

/**
 * The installer is fetched from a URL a recipe supplies and then executed, so a
 * hijacked host redirecting into an internal service is the threat that matters
 * here. `safeFetchBytes` owns that: HTTPS only, every hop re-checked against the
 * address policy, and a cap enforced while the body streams. What stays here is
 * what only an installer knows — that the payload has to look like a shell
 * script rather than a login page.
 */
async function fetchInstallerBytes(
  deps: InstallerDownloadDeps,
  request: InstallerDownloadRequest,
  signal: AbortSignal | undefined
): Promise<{ bytes: Uint8Array; url: string }> {
  try {
    const result = await safeFetchBytes(
      request.url,
      {
        maxBytes: request.maxBytes,
        maxRedirects: MAX_INSTALLER_REDIRECTS,
        ...(signal && { signal }),
      },
      deps
    );
    return { bytes: result.bytes, url: result.url };
  } catch (error) {
    if (error instanceof SafeFetchError) {
      throw new InstallerDownloadError(`Installer download refused: ${error.message}`);
    }
    if (signal?.aborted) {
      throw new InstallerDownloadError('Installer download was cancelled.');
    }
    throw error;
  }
}

function assertShellScript(bytes: Uint8Array, minBytes: number): void {
  if (bytes.byteLength < minBytes) {
    throw new InstallerDownloadError(`Installer is smaller than the ${minBytes}-byte minimum.`);
  }

  const prefix = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.byteLength, 1024)));
  const normalized = prefix.replace(/^\uFEFF/, '').trimStart();
  if (/^(?:<!doctype\s+html|<html)\b/i.test(normalized)) {
    throw new InstallerDownloadError('Installer response was HTML, not a shell script.');
  }
  const firstLine = normalized.split(/\r?\n/, 1)[0] ?? '';
  if (
    !/^#!\s*(?:\/usr\/bin\/env\s+(?:ba|z|k)?sh|\/(?:usr\/)?bin\/(?:ba|z|k)?sh)(?:\s|$)/.test(
      firstLine
    )
  ) {
    throw new InstallerDownloadError('Installer response does not have a shell shebang.');
  }
}

export function createInstallerDownloader(
  overrides: Partial<InstallerDownloadDeps> = {}
): InstallerDownloader {
  const deps = { ...defaultDeps, ...overrides };

  return {
    async download(request, options = {}) {
      assertSizeBounds(request);
      const { bytes, url } = await fetchInstallerBytes(deps, request, options.signal);
      assertShellScript(bytes, request.minBytes);

      const tempDir = await deps.createTempDir();
      const path = join(tempDir, 'installer.sh');
      try {
        await deps.writeFile(path, bytes);
      } catch (error) {
        await deps.removeDir(tempDir);
        throw error;
      }

      return {
        path,
        url,
        sizeBytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        cleanup: () => deps.removeDir(tempDir),
      };
    },
  };
}

export const installerDownloader = createInstallerDownloader();
