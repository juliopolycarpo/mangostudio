/**
 * Offline skills diagnostics for `mango doctor`: scans every source directory
 * (mango + the two opt-in third-party dirs) and classifies each discovered
 * skill so quiet, filesystem-shaped failures — an unreadable dir, a frontmatter
 * typo, a skill silently shadowed by a higher-precedence source, or one the
 * user disabled and forgot — become one deterministic line each. Pure over the
 * filesystem and the injected settings; never mutates and never connects.
 */

import { type Dirent, lstatSync, readdirSync } from 'node:fs';
import { join, parse, sep } from 'node:path';

import type { SkillSource } from '@mangostudio/shared/skills';

import { describeSkill, resolveWinnersBySlug, type ScannedSkill } from './skill-discovery';

/** Provenance of the effective `skills.dir`, mirroring config resolution order. */
export type SkillsConfigOrigin = 'default' | 'toml' | 'env';

/** Read state of one source directory. */
type SkillSourceHealth = 'ok' | 'missing' | 'unreadable';

export interface SkillSourceDiagnostic {
  source: SkillSource;
  dir: string;
  /** `mango` is always on; third-party dirs follow the app-settings toggle. */
  enabled: boolean;
  health: SkillSourceHealth;
  /** Directory entries that look like skills (valid or invalid); 0 when unreadable. */
  skillCount: number;
}

/** Per-skill classification, one of the mutually exclusive diagnosis states. */
type SkillState = 'active' | 'disabled' | 'shadowed' | 'invalid' | 'precedence-unverified';

export interface SkillDiagnostic {
  key: string;
  source: SkillSource;
  state: SkillState;
  /** The source that owns the slug when `state` is `shadowed`. */
  shadowedBy?: SkillSource;
  /** Frontmatter/read error when `state` is `invalid`. */
  error?: string;
}

interface SkillConfigDiagnostic {
  dir: string;
  origin: SkillsConfigOrigin;
}

export interface SkillsDiagnostics {
  config: SkillConfigDiagnostic;
  sources: SkillSourceDiagnostic[];
  skills: SkillDiagnostic[];
}

/** One source directory to scan; `enabled` mirrors its app-settings toggle. */
export interface SkillDiagnosticsSource {
  source: SkillSource;
  dir: string;
  enabled: boolean;
}

export interface SkillDiagnosticsInput {
  config: SkillConfigDiagnostic;
  /** All three sources, in precedence order; disabled ones are still scanned for the count. */
  sources: readonly SkillDiagnosticsSource[];
  /** Skill keys the user has switched off (`<source>:<slug>`). */
  disabledKeys: ReadonlySet<string>;
}

/**
 * Scans the sources and resolves each skill's state. Only enabled sources feed
 * shadowing and the per-skill list — matching runtime discovery, where a
 * disabled source contributes nothing — while every source still reports its
 * own read health and count so a populated-but-disabled dir is visible.
 * // Usage: collectSkillsDiagnostics({ config, sources, disabledKeys })
 */
export function collectSkillsDiagnostics(input: SkillDiagnosticsInput): SkillsDiagnostics {
  const sources: SkillSourceDiagnostic[] = [];
  const inPlay: ScannedSkill[] = [];
  const withheldSources = new Set<SkillSource>();
  let higherSourceUnverified = false;

  for (const source of input.sources) {
    const { health, skills, couldHideCopy } = scanSource(source.source, source.dir);
    sources.push({
      source: source.source,
      dir: source.dir,
      enabled: source.enabled,
      health,
      skillCount: skills.length,
    });
    if (source.enabled) {
      if (higherSourceUnverified) withheldSources.add(source.source);
      higherSourceUnverified ||= couldHideCopy;
      inPlay.push(...skills);
    }
  }

  const winners = resolveWinnersBySlug(inPlay);
  const sourceByKey = new Map(inPlay.map((skill) => [skill.key, skill.source]));
  const skills = inPlay
    .map((skill) => {
      const winningKey = winners.get(skill.slug) ?? skill.key;
      const winningSource = sourceByKey.get(winningKey) ?? skill.source;
      return classifySkill(
        skill,
        winningSource,
        input.disabledKeys,
        withheldSources.has(winningSource)
      );
    })
    .sort((left, right) => left.key.localeCompare(right.key));

  return { config: input.config, sources, skills };
}

function scanSource(
  source: SkillSource,
  dir: string
): { health: SkillSourceHealth; skills: ScannedSkill[]; couldHideCopy: boolean } {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return { ...sourceReadFailure(dir, error), skills: [] };
  }

  const skills = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => describeSkill(source, entry.name, join(dir, entry.name)));
  return { health: 'ok', skills, couldHideCopy: false };
}

function sourceReadFailure(
  dir: string,
  error: unknown
): { health: SkillSourceHealth; couldHideCopy: boolean } {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOTDIR') return { health: 'unreadable', couldHideCopy: false };
  if (code === 'ENOENT') {
    try {
      // Keep the final symlink visible to lstat even when the path ends in a separator.
      const trimmed = dir.replace(sep === '/' ? /\/+$/u : /[\\/]+$/u, '');
      lstatSync(trimmed.length >= parse(dir).root.length ? trimmed : dir);
    } catch (probeError) {
      if ((probeError as NodeJS.ErrnoException).code === 'ENOENT') {
        return { health: 'missing', couldHideCopy: false };
      }
    }
  }
  return { health: 'unreadable', couldHideCopy: true };
}

function classifySkill(
  skill: ScannedSkill,
  winningSource: SkillSource,
  disabledKeys: ReadonlySet<string>,
  precedenceUnverified: boolean
): SkillDiagnostic {
  const base = { key: skill.key, source: skill.source };

  if (skill.valid && precedenceUnverified) return { ...base, state: 'precedence-unverified' };
  if (winningSource !== skill.source) {
    return { ...base, state: 'shadowed', shadowedBy: winningSource };
  }

  if (!skill.valid) {
    return { ...base, state: 'invalid', error: skill.error };
  }
  if (disabledKeys.has(skill.key)) {
    return { ...base, state: 'disabled' };
  }
  return { ...base, state: 'active' };
}
