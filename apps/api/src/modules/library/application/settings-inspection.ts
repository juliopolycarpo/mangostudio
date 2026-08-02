import { type Dirent, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  LibraryLocationId,
  LibraryTargetId,
  SettingsSnapshot,
  SettingsSourceSnapshot,
} from '@mangostudio/shared/library';
import {
  getLibraryLocation,
  getLibraryTarget,
  LIBRARY_TARGET_DEFINITIONS,
  type LocationDefinition,
} from '@mangostudio/shared/library/host';
import type { PathEnv } from '@mangostudio/shared/runtime-env';
import {
  type RegularFileContent,
  RegularFileReadError,
  readRegularFileUtf8,
} from '../../../lib/safe-file';
import { createLibraryPathEnv } from '../infrastructure/location-probe';
import {
  type JsonSettingsParserOptions,
  parseJsonSettings,
} from '../infrastructure/settings-parsers/json';
import {
  type PermissionRulesSource,
  parsePermissionRules,
} from '../infrastructure/settings-parsers/rules';
import { parseTomlSettings } from '../infrastructure/settings-parsers/toml';
import type { SettingsParserResult } from '../infrastructure/settings-parsers/types';

const MAX_SETTINGS_SOURCE_BYTES = 512 * 1024;

/**
 * Claude's settings and hook sources are the same file, so the section has to be
 * claimed by exactly one of them or every hook field is reported twice under
 * identical paths.
 */
const JSON_SECTIONS: Readonly<
  Partial<Record<LibraryLocationId, Pick<JsonSettingsParserOptions, 'section' | 'excludeSections'>>>
> = {
  'claude-hooks': { section: 'hooks' },
  'claude-settings': { excludeSections: ['hooks'] },
};

interface RulesDirectoryContent {
  readonly sources: readonly PermissionRulesSource[];
  readonly sizeBytes: number;
}

export interface SettingsInspectionFs {
  readFile(path: string): RegularFileContent;
  readRulesDirectory(path: string): RulesDirectoryContent;
}

export interface SettingsInspectionOptions {
  readonly env?: PathEnv;
  readonly fs?: SettingsInspectionFs;
}

interface InspectionContext {
  readonly env: PathEnv;
  readonly fs: SettingsInspectionFs;
  readonly fileReads: Map<string, RegularFileContent | RegularFileReadError>;
  readonly directoryReads: Map<string, RulesDirectoryContent | RegularFileReadError>;
}

const nodeSettingsInspectionFs: SettingsInspectionFs = {
  readFile: (path) =>
    readRegularFileUtf8(path, {
      maxBytes: MAX_SETTINGS_SOURCE_BYTES,
    }),
  readRulesDirectory,
};

export function inspectSettingsTarget(
  targetId: LibraryTargetId,
  options: SettingsInspectionOptions = {}
): SettingsSnapshot {
  return inspectTarget(targetId, createContext(options));
}

export function inspectAllSettings(options: SettingsInspectionOptions = {}): SettingsSnapshot[] {
  const context = createContext(options);
  return LIBRARY_TARGET_DEFINITIONS.map((target) => inspectTarget(target.id, context));
}

function createContext(options: SettingsInspectionOptions): InspectionContext {
  return {
    env: options.env ?? createLibraryPathEnv(),
    fs: options.fs ?? nodeSettingsInspectionFs,
    fileReads: new Map(),
    directoryReads: new Map(),
  };
}

function inspectTarget(targetId: LibraryTargetId, context: InspectionContext): SettingsSnapshot {
  const target = getLibraryTarget(targetId);
  if (!target) throw new TypeError(`Unknown library target: ${targetId}`);

  const settings = target.reads.setting.map((locationId) => ({
    locationId,
    kind: 'setting' as const,
  }));
  const hooks = target.reads.hook.map((locationId) => ({
    locationId,
    kind: 'hook' as const,
  }));

  return {
    targetId,
    sources: [...settings, ...hooks].map(({ locationId, kind }) => {
      const location = getLibraryLocation(locationId);
      if (!location) throw new TypeError(`Unknown library location: ${locationId}`);
      return inspectSource(location, kind, context);
    }),
  };
}

function inspectSource(
  location: LocationDefinition,
  kind: SettingsSourceSnapshot['kind'],
  context: InspectionContext
): SettingsSourceSnapshot {
  const path = location.resolvePath(context.env);
  if (path === null) return absentSource(location, kind);

  if (location.format === 'rules-dsl') {
    const read = cachedDirectoryRead(path, context);
    if (read instanceof RegularFileReadError) return failedRead(location, kind, read);
    return parsedSource(
      location,
      kind,
      read.sizeBytes,
      parsePermissionRules(read.sources, { homeDir: context.env.homeDir })
    );
  }

  const read = cachedFileRead(path, context);
  if (read instanceof RegularFileReadError) return failedRead(location, kind, read);

  const options = { homeDir: context.env.homeDir };
  let result: SettingsParserResult;
  if (location.format === 'json-settings') {
    result = parseJsonSettings(read.content, { ...options, ...JSON_SECTIONS[location.id] });
  } else if (location.format === 'toml-settings') {
    result = parseTomlSettings(read.content, options);
  } else {
    throw new TypeError(`Unsupported settings format: ${location.format}`);
  }

  return parsedSource(location, kind, read.sizeBytes, result);
}

function parsedSource(
  location: LocationDefinition,
  kind: SettingsSourceSnapshot['kind'],
  sizeBytes: number,
  result: SettingsParserResult
): SettingsSourceSnapshot {
  return {
    locationId: location.id,
    kind,
    present: true,
    parsed: result.parsed,
    sizeBytes,
    ...(!result.parsed && { failureReason: result.failureReason }),
    fields: result.fields,
  };
}

function absentSource(
  location: LocationDefinition,
  kind: SettingsSourceSnapshot['kind']
): SettingsSourceSnapshot {
  return {
    locationId: location.id,
    kind,
    present: false,
    parsed: false,
    fields: [],
  };
}

function failedRead(
  location: LocationDefinition,
  kind: SettingsSourceSnapshot['kind'],
  error: RegularFileReadError
): SettingsSourceSnapshot {
  if (error.reason === 'not-found') return absentSource(location, kind);
  return {
    locationId: location.id,
    kind,
    present: true,
    parsed: false,
    failureReason: error.reason,
    fields: [],
  };
}

function cachedFileRead(
  path: string,
  context: InspectionContext
): RegularFileContent | RegularFileReadError {
  const cached = context.fileReads.get(path);
  if (cached) return cached;
  try {
    const read = context.fs.readFile(path);
    context.fileReads.set(path, read);
    return read;
  } catch (error) {
    if (!(error instanceof RegularFileReadError)) throw error;
    context.fileReads.set(path, error);
    return error;
  }
}

function cachedDirectoryRead(
  path: string,
  context: InspectionContext
): RulesDirectoryContent | RegularFileReadError {
  const cached = context.directoryReads.get(path);
  if (cached) return cached;
  try {
    const read = context.fs.readRulesDirectory(path);
    context.directoryReads.set(path, read);
    return read;
  } catch (error) {
    if (!(error instanceof RegularFileReadError)) throw error;
    context.directoryReads.set(path, error);
    return error;
  }
}

function readRulesDirectory(path: string): RulesDirectoryContent {
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch (error) {
    throw new RegularFileReadError(classifyDirectoryReadError(error));
  }

  const sources: PermissionRulesSource[] = [];
  let sizeBytes = 0;
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith('.') || !entry.isFile() || !entry.name.endsWith('.rules')) continue;
    const file = readRuleFile(join(path, entry.name));
    // A file unlinked between readdir and open must not turn a directory that
    // demonstrably exists into an absent source.
    if (file === null) continue;
    sizeBytes += file.sizeBytes;
    if (sizeBytes > MAX_SETTINGS_SOURCE_BYTES) throw new RegularFileReadError('too-large');
    sources.push({ name: entry.name, content: file.content });
  }
  return { sources, sizeBytes };
}

function readRuleFile(filePath: string): RegularFileContent | null {
  try {
    return readRegularFileUtf8(filePath, { maxBytes: MAX_SETTINGS_SOURCE_BYTES });
  } catch (error) {
    if (error instanceof RegularFileReadError && error.reason === 'not-found') return null;
    throw error;
  }
}

function classifyDirectoryReadError(error: unknown): RegularFileReadError['reason'] {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return 'not-found';
  if (code === 'ENOTDIR') return 'not-regular-file';
  return 'unreadable';
}
