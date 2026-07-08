/**
 * Offline skills diagnostics for `mango doctor`: scans every source directory
 * (mango + the two opt-in third-party dirs) and classifies each discovered
 * skill so quiet, filesystem-shaped failures — an unreadable dir, a frontmatter
 * typo, a skill silently shadowed by a higher-precedence source, or one the
 * user disabled and forgot — become one deterministic line each. Pure over the
 * filesystem and the injected settings; never mutates and never connects.
 */

import { type Dirent, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SkillSource } from '@mangostudio/shared/skills';
import { describeSkill, resolveWinnersBySlug, type ScannedSkill } from './skill-discovery';

/** Provenance of the effective `skills.dir`, mirroring config resolution order. */
export type SkillsConfigOrigin = 'default' | 'toml' | 'env';

/** Read state of one source directory. */
export type SkillSourceHealth = 'ok' | 'missing' | 'unreadable';

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
export type SkillState = 'active' | 'disabled' | 'shadowed' | 'invalid';

export interface SkillDiagnostic {
  key: string;
  source: SkillSource;
  state: SkillState;
  /** The source that owns the slug when `state` is `shadowed`. */
  shadowedBy?: SkillSource;
  /** Frontmatter/read error when `state` is `invalid`. */
  error?: string;
}

export interface SkillConfigDiagnostic {
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

  for (const source of input.sources) {
    const { health, skills } = scanSource(source.source, source.dir);
    sources.push({
      source: source.source,
      dir: source.dir,
      enabled: source.enabled,
      health,
      skillCount: skills.length,
    });
    if (source.enabled) inPlay.push(...skills);
  }

  const winners = resolveWinnersBySlug(inPlay);
  const skills = inPlay
    .map((skill) => classifySkill(skill, winners, input.disabledKeys, inPlay))
    .sort((left, right) => left.key.localeCompare(right.key));

  return { config: input.config, sources, skills };
}

function scanSource(
  source: SkillSource,
  dir: string
): { health: SkillSourceHealth; skills: ScannedSkill[] } {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    // A missing dir just means the source is empty; anything else (EACCES,
    // ENOTDIR) is a real read failure the operator should see.
    const health = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
    return { health, skills: [] };
  }

  const skills = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => describeSkill(source, entry.name, join(dir, entry.name)));
  return { health: 'ok', skills };
}

function classifySkill(
  skill: ScannedSkill,
  winners: Map<string, string>,
  disabledKeys: ReadonlySet<string>,
  inPlay: readonly ScannedSkill[]
): SkillDiagnostic {
  const base = { key: skill.key, source: skill.source };

  const winnerKey = winners.get(skill.slug);
  if (winnerKey && winnerKey !== skill.key) {
    const winner = inPlay.find((candidate) => candidate.key === winnerKey);
    return { ...base, state: 'shadowed', shadowedBy: winner?.source ?? skill.source };
  }

  if (!skill.valid) {
    return { ...base, state: 'invalid', error: skill.error };
  }
  if (disabledKeys.has(skill.key)) {
    return { ...base, state: 'disabled' };
  }
  return { ...base, state: 'active' };
}
