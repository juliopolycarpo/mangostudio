// Native gzipped-tar reading. `Bun.Archive` replaces the `tar -tzf` / `tar -xzf`
// subprocess pair everywhere this repository *reads* an archive, which also
// retires the Windows path rewriting those calls needed (MSYS tar cannot open a
// backslash path, so every call site carried a `--force-local` plus a
// backslash-to-slash rewrite; libarchive takes the path as given).
//
// Reading only. Archive *creation* stays on `tar` and `zip` — see
// `docs/reference/tooling.md` for the measurements and the reason.
//
// Two limits of the native reader, both verified against
// `1.4.0-canary.1+32e87032b`:
//
// - **gzip or stored only.** A plain `.tar` and a `.tar.gz` are both detected
//   from the bytes, but `.tar.xz` and `.tar.bz2` throw `Unrecognized archive
//   format` where GNU tar would have auto-detected them. Callers that ingest
//   third-party assets have to pin gzipped or uncompressed tarballs.
// - **zip is not readable at all**, so the zip halves of the release lane keep
//   their `unzip`/PowerShell subprocesses.
//
// The constructor takes bytes, not a `BunFile`: a lazy `Bun.file()` handle is
// accepted by the `Blob` overload and then fails with `Unrecognized archive
// format`, so every caller here reads the file first.

/** An opened archive: its entry listing, and extraction of the same instance. */
export interface ArchiveReader {
  /**
   * File entries, in archive order. Symlink and directory entries are absent —
   * `Bun.Archive#files()` reports regular files only.
   */
  readonly entries: readonly string[];
  extract(destination: string): Promise<void>;
}

/**
 * Open a gzipped or stored tar for listing and extraction, reading the file
 * once. Compression is detected from the bytes, not the name, so a stored
 * distribution bundle and a gzipped one open the same way.
 * Use this when entries must be judged before anything is written to disk.
 * // Usage: const archive = await openTarArchive(bundle)
 */
export async function openTarArchive(archivePath: string): Promise<ArchiveReader> {
  let entries: string[];
  let archive: Bun.Archive;
  try {
    archive = new Bun.Archive(await Bun.file(archivePath).bytes());
    entries = [...(await archive.files()).keys()];
  } catch (caught) {
    throw new Error(`Failed to read archive ${archivePath}: ${describe(caught)}`);
  }

  return {
    entries,
    extract: async (destination: string): Promise<void> => {
      await extractOrThrow(archive, archivePath, destination);
    },
  };
}

/**
 * Extract a gzipped tar without listing it first. For archives this repository
 * produced itself, where a listing pass would decompress a second time to judge
 * entries that are already known.
 * // Usage: await extractTarArchive(archivePath, extractDir)
 */
export async function extractTarArchive(archivePath: string, destination: string): Promise<void> {
  let archive: Bun.Archive;
  try {
    archive = new Bun.Archive(await Bun.file(archivePath).bytes());
  } catch (caught) {
    throw new Error(`Failed to read archive ${archivePath}: ${describe(caught)}`);
  }
  await extractOrThrow(archive, archivePath, destination);
}

async function extractOrThrow(
  archive: Bun.Archive,
  archivePath: string,
  destination: string
): Promise<void> {
  try {
    await archive.extract(destination);
  } catch (caught) {
    throw new Error(`Failed to extract archive ${archivePath}: ${describe(caught)}`);
  }
}

function describe(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}
