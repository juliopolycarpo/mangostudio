/**
 * Raw settings and hook sources from the machine that holds them.
 *
 * Only the opening of files happens here. Parsing, redaction, and the concept
 * comparison across targets are hub decisions over these bytes — they need no
 * filesystem, and keeping them hub-side means one parser, not one per host.
 *
 * The location set comes from the target registry rather than a list in this
 * file, so a new settings location is a registry row and not a method change.
 * Two locations can name the same file (Claude's settings and hooks are one
 * `settings.json`), and it is opened once.
 */

import {
  closeSync,
  type Dirent,
  constants as fsConstants,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
} from 'node:fs';
import { join } from 'node:path';
import type { LibraryLocationId } from '@mangostudio/shared/library';
import {
  getLibraryLocation,
  LIBRARY_TARGET_DEFINITIONS,
  type LocationDefinition,
} from '@mangostudio/shared/library/host';
import type { PathEnv } from '@mangostudio/shared/runtime-env';

/** Ceiling for one settings source, matching the pre-relocation hub reader. */
const MAX_SETTINGS_SOURCE_BYTES = 512 * 1024;

// O_NOFOLLOW makes a final-component symlink fail the open instead of silently
// resolving to its target: a settings path is a fixed, vendor-defined name, so
// anything it points at elsewhere is not the file the user was asked about.
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const READ_FLAGS = fsConstants.O_RDONLY | O_NOFOLLOW;

/** Why a source that exists could not be turned into settings text. */
type RuntimeSettingsReadFailure = 'unreadable' | 'not-regular-file' | 'too-large';

interface RuntimeSettingsRuleFile {
  readonly name: string;
  readonly content: string;
}

export interface RuntimeSettingsSource {
  readonly locationId: LibraryLocationId;
  /**
   * False when the location does not resolve on this machine or nothing is
   * there. A missing settings file is an ordinary state, not a failure.
   */
  readonly present: boolean;
  readonly sizeBytes?: number;
  readonly failureReason?: RuntimeSettingsReadFailure;
  /** Raw text, for every format except `rules-dsl`. */
  readonly content?: string;
  /** One entry per `.rules` file, name-sorted, for `rules-dsl` locations. */
  readonly rules?: readonly RuntimeSettingsRuleFile[];
}

export interface RuntimeSettingsSourcesResult {
  /**
   * This machine's home directory. The hub's parsers abbreviate paths against
   * it, and abbreviating a remote path against the hub's home would be wrong.
   */
  readonly homeDir: string;
  readonly sources: readonly RuntimeSettingsSource[];
}

/** Every location any target reads settings or hooks from, in registry order. */
function settingsSourceLocationIds(): LibraryLocationId[] {
  const seen = new Set<LibraryLocationId>();
  for (const target of LIBRARY_TARGET_DEFINITIONS) {
    for (const locationId of [...target.reads.setting, ...target.reads.hook]) {
      seen.add(locationId);
    }
  }
  return [...seen];
}

export function readSettingsSources(env: PathEnv): RuntimeSettingsSourcesResult {
  const byPath = new Map<string, RuntimeSettingsSource>();
  const sources = settingsSourceLocationIds().map((locationId) => {
    const location = getLibraryLocation(locationId);
    if (!location) return { locationId, present: false };
    const path = location.resolvePath(env);
    if (path === null) return { locationId, present: false };

    const cached = byPath.get(path);
    if (cached) return { ...cached, locationId };
    const source = { ...readSource(location, path), locationId };
    byPath.set(path, source);
    return source;
  });
  return { homeDir: env.homeDir, sources };
}

function readSource(location: LocationDefinition, path: string): RuntimeSettingsSource {
  const locationId = location.id;
  if (location.format === 'rules-dsl') {
    const read = readRulesDirectory(path);
    // null is "nothing there" — same as a missing settings file, not an empty
    // present directory (which would report present: true with rules: []).
    if (read === null) return { locationId, present: false };
    return read.failureReason === undefined
      ? { locationId, present: true, sizeBytes: read.sizeBytes, rules: read.rules }
      : failed(locationId, read.failureReason);
  }

  try {
    const { content, sizeBytes } = readBoundedUtf8(path);
    return { locationId, present: true, sizeBytes, content };
  } catch (error) {
    const reason = classifyReadError(error);
    return reason === null ? { locationId, present: false } : failed(locationId, reason);
  }
}

function failed(
  locationId: LibraryLocationId,
  failureReason: RuntimeSettingsReadFailure
): RuntimeSettingsSource {
  return { locationId, present: true, failureReason };
}

interface RulesDirectoryRead {
  readonly rules: readonly RuntimeSettingsRuleFile[];
  readonly sizeBytes: number;
  readonly failureReason?: RuntimeSettingsReadFailure;
}

/**
 * Null means the directory is absent (`ENOENT`). An empty existing directory
 * is a successful present read with `rules: []`.
 */
function readRulesDirectory(path: string): RulesDirectoryRead | null {
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return null;
    return {
      rules: [],
      sizeBytes: 0,
      failureReason: code === 'ENOTDIR' ? 'not-regular-file' : 'unreadable',
    };
  }

  const rules: RuntimeSettingsRuleFile[] = [];
  let sizeBytes = 0;
  for (const entry of entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  )) {
    if (entry.name.startsWith('.') || !entry.isFile() || !entry.name.endsWith('.rules')) continue;
    let file: { content: string; sizeBytes: number };
    try {
      file = readBoundedUtf8(join(path, entry.name));
    } catch (error) {
      // A file unlinked between readdir and open must not turn a directory that
      // demonstrably exists into an absent source.
      if (classifyReadError(error) === null) continue;
      return { rules: [], sizeBytes: 0, failureReason: 'unreadable' };
    }
    sizeBytes += file.sizeBytes;
    if (sizeBytes > MAX_SETTINGS_SOURCE_BYTES) {
      return { rules: [], sizeBytes: 0, failureReason: 'too-large' };
    }
    rules.push({ name: entry.name, content: file.content });
  }
  return { rules, sizeBytes };
}

/**
 * Opens once and validates the descriptor with `fstat`, rather than stat-ing a
 * path another process could swap in between.
 */
function readBoundedUtf8(path: string): { content: string; sizeBytes: number } {
  const fd = openSync(path, READ_FLAGS);
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new SettingsReadError('not-regular-file');
    const sizeBytes = stats.size;
    if (sizeBytes > MAX_SETTINGS_SOURCE_BYTES) throw new SettingsReadError('too-large');
    if (sizeBytes === 0) return { content: '', sizeBytes };

    const buffer = Buffer.alloc(sizeBytes);
    let offset = 0;
    while (offset < sizeBytes) {
      const bytesRead = readSync(fd, buffer, offset, sizeBytes - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return { content: buffer.subarray(0, offset).toString('utf8'), sizeBytes };
  } finally {
    closeSync(fd);
  }
}

class SettingsReadError extends Error {
  constructor(readonly reason: RuntimeSettingsReadFailure) {
    super(`Cannot read settings source: ${reason}`);
    this.name = 'SettingsReadError';
  }
}

/** Null means "nothing there" — the one outcome that is not a failure. */
function classifyReadError(error: unknown): RuntimeSettingsReadFailure | null {
  if (error instanceof SettingsReadError) return error.reason;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return null;
  // ELOOP: O_NOFOLLOW rejected a symlink. EISDIR: a directory where supported.
  if (code === 'ELOOP' || code === 'EISDIR') return 'not-regular-file';
  return 'unreadable';
}
