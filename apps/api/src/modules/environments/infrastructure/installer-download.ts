import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_INSTALLER_REDIRECTS = 5;
const INSTALLER_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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

interface InstallerDownloadDeps {
  readonly fetch: typeof fetch;
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

async function fetchInstaller(
  deps: InstallerDownloadDeps,
  requestedUrl: URL,
  signal: AbortSignal | undefined
): Promise<{ response: Response; resolvedUrl: URL }> {
  let currentUrl = requestedUrl;
  let redirectCount = 0;

  while (true) {
    const response = await deps.fetch(currentUrl, {
      redirect: 'manual',
      ...(signal && { signal }),
    });
    if (!INSTALLER_REDIRECT_STATUSES.has(response.status)) {
      const resolvedUrl = response.url ? new URL(response.url) : currentUrl;
      if (resolvedUrl.protocol !== 'https:') {
        throw new InstallerDownloadError('Installer resolved to a non-HTTPS URL.');
      }
      return { response, resolvedUrl };
    }

    if (redirectCount >= MAX_INSTALLER_REDIRECTS) {
      throw new InstallerDownloadError('Installer exceeded the redirect limit.');
    }
    const location = response.headers.get('location');
    if (!location) {
      throw new InstallerDownloadError('Installer redirect did not include a location.');
    }

    let nextUrl: URL;
    try {
      nextUrl = new URL(location, currentUrl);
    } catch {
      throw new InstallerDownloadError('Installer redirected to an invalid URL.');
    }
    if (nextUrl.protocol !== 'https:') {
      throw new InstallerDownloadError('Installer redirected to a non-HTTPS URL.');
    }
    await response.body?.cancel().catch(() => undefined);
    currentUrl = nextUrl;
    redirectCount += 1;
  }
}

function validateRequest(request: InstallerDownloadRequest): URL {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new InstallerDownloadError('Installer URL is invalid.');
  }
  if (url.protocol !== 'https:') {
    throw new InstallerDownloadError('Installer URL must use HTTPS.');
  }
  if (
    !Number.isSafeInteger(request.minBytes) ||
    !Number.isSafeInteger(request.maxBytes) ||
    request.minBytes < 1 ||
    request.maxBytes < request.minBytes
  ) {
    throw new InstallerDownloadError('Installer size bounds are invalid.');
  }
  return url;
}

async function readResponseBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new InstallerDownloadError(`Installer exceeds the ${maxBytes}-byte limit.`);
  }
  if (!response.body) {
    throw new InstallerDownloadError('Installer response had no body.');
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new InstallerDownloadError(`Installer exceeds the ${maxBytes}-byte limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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
      const requestedUrl = validateRequest(request);
      let response: Response;
      let resolvedUrl: URL;
      try {
        ({ response, resolvedUrl } = await fetchInstaller(deps, requestedUrl, options.signal));
      } catch (error) {
        if (error instanceof InstallerDownloadError) throw error;
        if (options.signal?.aborted) {
          throw new InstallerDownloadError('Installer download was cancelled.');
        }
        const detail = error instanceof Error ? error.message : 'Unknown network error.';
        throw new InstallerDownloadError(`Installer download failed: ${detail}`);
      }

      if (!response.ok) {
        throw new InstallerDownloadError(`Installer download returned HTTP ${response.status}.`);
      }

      const bytes = await readResponseBounded(response, request.maxBytes);
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
        url: resolvedUrl.href,
        sizeBytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        cleanup: () => deps.removeDir(tempDir),
      };
    },
  };
}

export const installerDownloader = createInstallerDownloader();
