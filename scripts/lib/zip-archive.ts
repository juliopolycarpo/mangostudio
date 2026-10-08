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
  const unzipCommand =
    dependencies.unzipCommand === undefined ? Bun.which('unzip') : dependencies.unzipCommand;
  const runCommand = dependencies.runCommand ?? captureCommand;
  const commands = zipArchiveCommands(archivePath, '', unzipCommand, dependencies.platform);
  const listing = await runArchiveCommand('list', archivePath, commands.list, runCommand);

  return {
    entries: listing.split(/\r?\n/).filter(Boolean),
    extract: async (destination: string): Promise<void> => {
      const { extract } = zipArchiveCommands(
        archivePath,
        destination,
        unzipCommand,
        dependencies.platform
      );
      await runArchiveCommand('extract', archivePath, extract, runCommand);
    },
  };
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
