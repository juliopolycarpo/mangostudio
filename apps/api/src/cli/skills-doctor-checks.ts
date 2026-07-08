/**
 * Renders the skills section of `mango doctor`. Owns the DB/config reads doctor
 * needs (source toggles, per-skill disabled flags, effective `skills.dir` and
 * where it came from) and hands them to the offline collector, then maps the
 * structured diagnosis onto checklist rows. The scan itself lives in the skills
 * module; this file is the CLI-facing seam.
 */

import {
  collectSkillsDiagnostics,
  type SkillDiagnostic,
  type SkillSourceDiagnostic,
  type SkillsConfigOrigin,
} from '../modules/skills/application/skill-diagnostics';
import { getThirdPartySkillDirs } from '../modules/skills/application/skill-discovery';
import { type CheckResult, fail, ok, warn } from './doctor-checks';

const SOURCE_LABELS: Record<SkillSourceDiagnostic['source'], string> = {
  mango: 'Skills mango',
  agents: 'Skills agents',
  claude: 'Skills claude',
};

/** DB/config-derived inputs the doctor command gathers for the collector. */
export interface SkillsDoctorInput {
  /** Effective `skills.dir` (the mango source). */
  configDir: string;
  configOrigin: SkillsConfigOrigin;
  /** Opt-in third-party source toggles from app settings. */
  sourceToggles: { agents: boolean; claude: boolean };
  /** Skill keys switched off in per-skill settings (`<source>:<slug>`). */
  disabledKeys: ReadonlySet<string>;
  /** Overridable for tests; defaults to the fixed third-party dirs. */
  thirdPartyDirs?: { agents: string; claude: string };
}

/**
 * Scans the sources and renders the skills checklist: an effective-config row,
 * one row per source directory, and one row per skill that is not silently
 * active (invalid, shadowed, or disabled).
 * // Usage: collectSkillsDoctorChecks(input)
 */
export function collectSkillsDoctorChecks(input: SkillsDoctorInput): CheckResult[] {
  const thirdParty = input.thirdPartyDirs ?? getThirdPartySkillDirs();
  const diagnostics = collectSkillsDiagnostics({
    config: { dir: input.configDir, origin: input.configOrigin },
    sources: [
      { source: 'mango', dir: input.configDir, enabled: true },
      { source: 'agents', dir: thirdParty.agents, enabled: input.sourceToggles.agents },
      { source: 'claude', dir: thirdParty.claude, enabled: input.sourceToggles.claude },
    ],
    disabledKeys: input.disabledKeys,
  });

  const results: CheckResult[] = [
    ok('Skills config', `${diagnostics.config.dir} (from ${diagnostics.config.origin})`),
    ...diagnostics.sources.map(renderSource),
  ];

  for (const skill of diagnostics.skills) {
    const row = renderSkill(skill);
    if (row) results.push(row);
  }

  return results;
}

function renderSource(source: SkillSourceDiagnostic): CheckResult {
  const label = SOURCE_LABELS[source.source];
  const suffix = source.enabled ? '' : ' (source disabled)';

  if (source.health === 'unreadable') {
    // An enabled source that cannot be read hides skills the user expects;
    // a disabled one that is unreadable is only worth noting.
    return source.enabled
      ? fail(label, `${source.dir} (not readable)`)
      : warn(label, `${source.dir} (not readable, source disabled)`);
  }
  if (source.health === 'missing') {
    return ok(label, `${source.dir} (no skills directory yet)${suffix}`);
  }
  return ok(label, `${source.dir} — ${source.skillCount} skill(s)${suffix}`);
}

function renderSkill(skill: SkillDiagnostic): CheckResult | null {
  const label = `Skill ${skill.key}`;
  switch (skill.state) {
    case 'invalid':
      return fail(label, skill.error ?? 'invalid skill');
    case 'shadowed':
      return warn(label, `shadowed by ${skill.shadowedBy} source (higher precedence)`);
    case 'disabled':
      return ok(label, 'disabled in settings');
    default:
      // Active skills are already counted in their source row; no separate line.
      return null;
  }
}
