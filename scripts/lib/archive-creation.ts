import { posix, win32 } from 'node:path';

export interface ArchiveCreationCommand {
  readonly command: readonly [string, ...string[]];
  readonly cwd: string;
}

export interface TarSource {
  readonly directory: string;
  readonly members: readonly string[];
}

interface CreationHost {
  readonly platform?: NodeJS.Platform;
  readonly windowsDirectory?: string;
}

interface TarCreationOptions extends CreationHost {
  readonly format?: 'tar' | 'tar.gz' | 'tar.xz' | 'tar.bz2';
  readonly exclude?: readonly string[];
}

const TAR_FLAGS = { tar: '-cf', 'tar.gz': '-czf', 'tar.xz': '-cJf', 'tar.bz2': '-cjf' } as const;

/**
 * Create a tar command that keeps the output filename local and preserves file
 * modes. Windows uses its native bsdtar instead of MSYS argument parsing.
 * @example
 * const { command, cwd } = tarCreationCommand(out, [{ directory: source, members: ['.'] }]);
 * const child = Bun.spawn({ cmd: [...command], cwd });
 */
export function tarCreationCommand(
  archivePath: string,
  sources: readonly TarSource[],
  options: TarCreationOptions = {}
): ArchiveCreationCommand {
  const platform = options.platform ?? process.platform;
  const paths = platform === 'win32' ? win32 : posix;
  const archive = paths.resolve(archivePath);
  let tar = 'tar';
  if (platform === 'darwin') tar = '/usr/bin/tar';
  if (platform === 'win32') {
    tar = win32.join(
      options.windowsDirectory ?? process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'tar.exe'
    );
  }
  const format = options.format ?? 'tar.gz';
  const command: [string, ...string[]] = [tar, TAR_FLAGS[format], paths.basename(archive)];
  if (format === 'tar.gz' && (platform === 'win32' || platform === 'darwin')) {
    // libarchive otherwise records creation time in the gzip header, changing
    // checksums of identical inputs across seconds. File mtimes stay intact.
    // https://github.com/libarchive/libarchive/blob/v3.8.8/libarchive/archive_write_set_options.3
    command.push('--options', 'gzip:!timestamp');
  }
  command.push(...(options.exclude ?? []).map((pattern) => `--exclude=${pattern}`));
  for (const source of sources) {
    const directory = paths.resolve(source.directory);
    command.push(
      '-C',
      platform === 'win32' ? directory.replaceAll('\\', '/') : directory,
      ...source.members
    );
  }
  return { command, cwd: paths.dirname(archive) };
}

/**
 * Archive the contents of a staged directory without wrapping them in another
 * directory. Windows needs no external zip utility.
 * @example
 * const { command, cwd } = zipCreationCommand(out, staging);
 * const child = Bun.spawn({ cmd: [...command], cwd });
 */
export function zipCreationCommand(
  archivePath: string,
  sourceDirectory: string,
  host: CreationHost = {}
): ArchiveCreationCommand {
  const platform = host.platform ?? process.platform;
  const paths = platform === 'win32' ? win32 : posix;
  const archive = paths.resolve(archivePath);
  const source = paths.resolve(sourceDirectory);
  if (platform !== 'win32') return { command: ['zip', '-qr', archive, '.'], cwd: source };

  return {
    command: [
      'powershell',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      [
        "$ErrorActionPreference = 'Stop'",
        'Add-Type -AssemblyName System.IO.Compression.FileSystem',
        `[IO.Compression.ZipFile]::CreateFromDirectory('${powerShellLiteral(source)}', '${powerShellLiteral(archive)}', [IO.Compression.CompressionLevel]::Optimal, $false)`,
      ].join('; '),
    ],
    cwd: source,
  };
}

function powerShellLiteral(value: string): string {
  return value.replaceAll("'", "''");
}
