import type { ArchiveReader } from './archive';
import { type CaptureResult, captureCommand } from './exec';

interface ArchiveCommands {
  readonly list: readonly string[];
  readonly extract: readonly string[];
}

export interface ZipArchiveDependencies {
  readonly runCommand?: (command: string[]) => Promise<CaptureResult>;
  readonly unzipCommand?: string | null;
  readonly platform?: NodeJS.Platform;
}

/**
 * Build ZIP listing and extraction commands, using unzip when available and
 * PowerShell otherwise. Bun.Archive reads tar archives only.
 * // Usage: zipArchiveCommands('tools.zip', 'tools', null, 'win32')
 */
export function zipArchiveCommands(
  archivePath: string,
  destination: string,
  unzipCommand: string | null,
  platform: NodeJS.Platform = process.platform
): ArchiveCommands {
  if (unzipCommand) {
    const toUnzipPath = (path: string): string =>
      platform === 'win32' ? path.replaceAll('\\', '/') : path;
    return {
      list: [unzipCommand, '-Z1', toUnzipPath(archivePath)],
      extract: [unzipCommand, '-q', toUnzipPath(archivePath), '-d', toUnzipPath(destination)],
    };
  }

  const archive = powerShellLiteral(archivePath);
  const target = powerShellLiteral(destination);
  return {
    list: [
      'powershell',
      '-NoProfile',
      '-Command',
      [
        // A non-terminating cmdlet error must fail the listing as a whole.
        "$ErrorActionPreference = 'Stop'",
        'Add-Type -AssemblyName System.IO.Compression.FileSystem',
        `$zip = [IO.Compression.ZipFile]::OpenRead('${archive}')`,
        // Console output avoids PowerShell's formatter wrapping entry names.
        'try { $zip.Entries | ForEach-Object { [Console]::Out.WriteLine($_.FullName) } } finally { $zip.Dispose() }',
      ].join('; '),
    ],
    extract: [
      'powershell',
      '-NoProfile',
      '-Command',
      `$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath '${archive}' -DestinationPath '${target}' -Force`,
    ],
  };
}

/**
 * List a ZIP before extraction so the caller can reject unsafe entry paths.
 * This reader does not judge paths or extract until its extract method is called.
 * // Usage: const zip = await openZipArchive('tools.zip')
 */
export async function openZipArchive(
  archivePath: string,
  dependencies: ZipArchiveDependencies = {}
): Promise<ArchiveReader> {
  // Resolved once, so the listing and the extraction run the same tool.
  const resolved = { ...dependencies, unzipCommand: resolveUnzipCommand(dependencies) };
  const commands = zipArchiveCommands(archivePath, '', resolved.unzipCommand, resolved.platform);
  const listing = await runArchiveCommand(
    'list',
    archivePath,
    commands.list,
    resolved.runCommand ?? captureCommand
  );

  return {
    entries: listing.split(/\r?\n/).filter(Boolean),
    extract: (destination: string): Promise<void> =>
      extractZipArchive(archivePath, destination, resolved),
  };
}

/**
 * Extract a ZIP whose entries the caller has already judged, without listing it again.
 * // Usage: await extractZipArchive('tools.zip', 'tools')
 */
export async function extractZipArchive(
  archivePath: string,
  destination: string,
  dependencies: ZipArchiveDependencies = {}
): Promise<void> {
  const { extract } = zipArchiveCommands(
    archivePath,
    destination,
    resolveUnzipCommand(dependencies),
    dependencies.platform
  );
  await runArchiveCommand(
    'extract',
    archivePath,
    extract,
    dependencies.runCommand ?? captureCommand
  );
}

/** An injected `null` means "no unzip here"; only an absent choice probes PATH. */
function resolveUnzipCommand(dependencies: ZipArchiveDependencies): string | null {
  return dependencies.unzipCommand === undefined ? Bun.which('unzip') : dependencies.unzipCommand;
}

async function runArchiveCommand(
  operation: 'list' | 'extract',
  archivePath: string,
  command: readonly string[],
  runCommand: (command: string[]) => Promise<CaptureResult>
): Promise<string> {
  const result = await runCommand([...command]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to ${operation} ZIP archive ${archivePath}: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`
    );
  }
  return result.stdout;
}

function powerShellLiteral(value: string): string {
  return value.replaceAll("'", "''");
}
