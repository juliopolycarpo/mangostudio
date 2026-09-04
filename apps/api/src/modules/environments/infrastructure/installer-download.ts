import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SafeFetchDeps, SafeFetchError, safeFetchBytes } from '../../../lib/safe-fetch';
import type { DownloadedInstaller } from '../domain/install-recipes';

const MAX_INSTALLER_REDIRECTS = 5;
const INSPECTION_WINDOW_BYTES = 4096;

/** Same shape a recipe declares per platform — the request is a `DownloadedInstaller` as-is. */
type InstallerDownloadRequest = DownloadedInstaller;

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
 * what only an installer knows — that the payload has to look like the script
 * kind the recipe declared rather than a login page.
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
    // Cancellation is checked before the refusal branch: an abort surfaces as a
    // `SafeFetchError` like any other failure, so testing that first would
    // report a caller's own cancellation as the host having refused us.
    if (signal?.aborted) {
      throw new InstallerDownloadError('Installer download was cancelled.');
    }
    if (error instanceof SafeFetchError) {
      throw new InstallerDownloadError(`Installer download refused: ${error.message}`);
    }
    throw error;
  }
}

/**
 * A recipe with an immutable source URL pins the digest it expects ahead of
 * time; checked before any content inspection because a digest mismatch is
 * the stronger signal — it is wrong regardless of what the bytes look like.
 */
function assertPinnedDigest(bytes: Uint8Array, expected: string | undefined): void {
  if (!expected) return;
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) {
    throw new InstallerDownloadError(
      `installer digest mismatch: expected ${expected} | received ${actual}`
    );
  }
}

function isHtmlResponse(normalized: string): boolean {
  return /^(?:<!doctype\s+html|<html)\b/i.test(normalized);
}

/** A shebang is on the first line, so a shell script needs a far smaller window than a `.ps1`. */
const SHELL_INSPECTION_WINDOW_BYTES = 1024;

/**
 * The decoded head of a downloaded installer, ready to recognize by content:
 * long enough to be a script at all, BOM stripped, and not the HTML a CDN or
 * captive portal serves when it means to refuse. What counts as the right
 * *kind* of script is each caller's own check.
 */
function inspectionPrefix(
  bytes: Uint8Array,
  minBytes: number,
  windowBytes: number,
  kind: 'shell script' | 'PowerShell script'
): string {
  if (bytes.byteLength < minBytes) {
    throw new InstallerDownloadError(`Installer is smaller than the ${minBytes}-byte minimum.`);
  }

  const prefix = new TextDecoder().decode(
    bytes.subarray(0, Math.min(bytes.byteLength, windowBytes))
  );
  const normalized = prefix.replace(/^\uFEFF/, '');
  if (isHtmlResponse(normalized.trimStart())) {
    throw new InstallerDownloadError(`Installer response was HTML, not a ${kind}.`);
  }
  return normalized;
}

function assertShellScript(bytes: Uint8Array, minBytes: number): void {
  const normalized = inspectionPrefix(
    bytes,
    minBytes,
    SHELL_INSPECTION_WINDOW_BYTES,
    'shell script'
  ).trimStart();
  const firstLine = normalized.split(/\r?\n/, 1)[0] ?? '';
  if (
    !/^#!\s*(?:\/usr\/bin\/env\s+(?:ba|z|k)?sh|\/(?:usr\/)?bin\/(?:ba|z|k)?sh)(?:\s|$)/.test(
      firstLine
    )
  ) {
    throw new InstallerDownloadError('Installer response does not have a shell shebang.');
  }
}

/**
 * PowerShell has no shebang convention, so a `.ps1` body is recognized by
 * content instead: not HTML, and at least one token that only shows up in a
 * PowerShell script within the first 4 KiB.
 */
const POWERSHELL_TOKEN_PATTERN =
  /\bparam\s*\(|\bfunction\s+\S|\$env:\w|Invoke-WebRequest|Write-Host|#Requires|\$[A-Za-z_]\w*\s*=/;

function assertPowerShellScript(bytes: Uint8Array, minBytes: number): void {
  const normalized = inspectionPrefix(
    bytes,
    minBytes,
    INSPECTION_WINDOW_BYTES,
    'PowerShell script'
  );
  if (!POWERSHELL_TOKEN_PATTERN.test(normalized)) {
    throw new InstallerDownloadError('Installer response does not look like a PowerShell script.');
  }
}

/** `powershell -File` refuses to run a script whose extension is not `.ps1`. */
function installerFileName(interpreter: DownloadedInstaller['interpreter']): string {
  return interpreter === 'powershell' ? 'installer.ps1' : 'installer.sh';
}

export function createInstallerDownloader(
  overrides: Partial<InstallerDownloadDeps> = {}
): InstallerDownloader {
  const deps = { ...defaultDeps, ...overrides };

  return {
    async download(request, options = {}) {
      assertSizeBounds(request);
      const { bytes, url } = await fetchInstallerBytes(deps, request, options.signal);
      assertPinnedDigest(bytes, request.sha256);
      if (request.interpreter === 'powershell') {
        assertPowerShellScript(bytes, request.minBytes);
      } else {
        assertShellScript(bytes, request.minBytes);
      }

      const tempDir = await deps.createTempDir();
      const path = join(tempDir, installerFileName(request.interpreter));
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
