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

import { type Dirent, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PathEnv } from '../../runtime-env';
import { getLibraryLocation, LIBRARY_TARGET_DEFINITIONS, type LocationDefinition } from '../host';
import type {
  LibraryLocationId,
  RuntimeSettingsReadFailure,
  RuntimeSettingsRuleFile,
  RuntimeSettingsSource,
  RuntimeSettingsSourcesResult,
} from '../index';
import {
  MAX_SETTINGS_SOURCE_BYTES,
  readBoundedUtf8,
  SettingsReadError,
} from './settings-file-reader';

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

/** Null means "nothing there" — the one outcome that is not a failure. */
function classifyReadError(error: unknown): RuntimeSettingsReadFailure | null {
  if (error instanceof SettingsReadError) return error.reason;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return null;
  // ELOOP: O_NOFOLLOW rejected a symlink. EISDIR: a directory where supported.
  if (code === 'ELOOP' || code === 'EISDIR') return 'not-regular-file';
  return 'unreadable';
}
