/**
 * Settings snapshots from source bytes the runtime already read.
 *
 * Nothing here touches a filesystem: `library.settings-sources` opens the files
 * on the machine that owns them, and this turns those bytes into the per-target
 * snapshot the comparison screen renders. One parser for every environment is
 * the point — a remote machine's `settings.json` must be read exactly the way
 * the hub's own is.
 */

import type { RuntimeSettingsSource, RuntimeSettingsSourcesResult } from '@mangostudio/runtime';
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

/**
 * What the runtime found at each settings location, plus the home directory of
 * the machine it found them on — the parsers abbreviate paths against it, and
 * abbreviating a remote path against the hub's home would name the wrong file.
 */
export type SettingsSourcePayload = RuntimeSettingsSourcesResult;

export function inspectSettingsTarget(
  targetId: LibraryTargetId,
  payload: SettingsSourcePayload
): SettingsSnapshot {
  return inspectTarget(targetId, createContext(payload));
}

export function inspectAllSettings(payload: SettingsSourcePayload): SettingsSnapshot[] {
  const context = createContext(payload);
  return LIBRARY_TARGET_DEFINITIONS.map((target) => inspectTarget(target.id, context));
}

interface InspectionContext {
  readonly homeDir: string;
  readonly sourcesById: ReadonlyMap<LibraryLocationId, RuntimeSettingsSource>;
}

function createContext(payload: SettingsSourcePayload): InspectionContext {
  return {
    homeDir: payload.homeDir,
    sourcesById: new Map(payload.sources.map((source) => [source.locationId, source])),
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
  const source = context.sourcesById.get(location.id);
  // A location the runtime did not report is one that does not resolve there.
  if (!source?.present) return absentSource(location, kind);
  if (source.failureReason !== undefined) {
    return {
      locationId: location.id,
      kind,
      present: true,
      parsed: false,
      failureReason: source.failureReason,
      fields: [],
    };
  }

  const options = { homeDir: context.homeDir };
  const sizeBytes = source.sizeBytes ?? 0;
  if (location.format === 'rules-dsl') {
    const rules: PermissionRulesSource[] = [...(source.rules ?? [])];
    return parsedSource(location, kind, sizeBytes, parsePermissionRules(rules, options));
  }

  const content = source.content ?? '';
  let result: SettingsParserResult;
  if (location.format === 'json-settings') {
    result = parseJsonSettings(content, { ...options, ...JSON_SECTIONS[location.id] });
  } else if (location.format === 'toml-settings') {
    result = parseTomlSettings(content, options);
  } else {
    throw new TypeError(`Unsupported settings format: ${location.format}`);
  }

  return parsedSource(location, kind, sizeBytes, result);
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
