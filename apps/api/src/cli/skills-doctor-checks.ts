/**
 * Renders the skills section of `mango doctor`. Owns the DB/config reads doctor
 * needs (source toggles, per-skill disabled flags, effective `skills.dir` and
 * where it came from) and hands them to the offline collector, then maps the
 * structured diagnosis onto checklist rows. The scan itself lives in the skills
 * module; this file is the CLI-facing seam.
 */

import type { MachineCheckKey } from '@mangostudio/shared/machine/check-text-en';

import {
  collectSkillsDiagnostics,
  type SkillDiagnostic,
  type SkillsConfigOrigin,
  type SkillSourceDiagnostic,
} from '../modules/skills/application/skill-diagnostics';
import { getThirdPartySkillDirs } from '../modules/skills/application/skill-discovery';
import { type CheckResult, keyedCheck } from './doctor-checks';

const SOURCE_LABELS = {
  mango: 'skills.label.mango',
  agents: 'skills.label.agents',
  claude: 'skills.label.claude',
} as const satisfies Record<SkillSourceDiagnostic['source'], MachineCheckKey>;

/** One sentence per origin, so each language words "from the env" its own way. */
const CONFIG_DETAIL_KEYS = {
  default: 'skills.detail.configFromDefault',
  toml: 'skills.detail.configFromToml',
  env: 'skills.detail.configFromEnv',
} as const satisfies Record<SkillsConfigOrigin, MachineCheckKey>;

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
 * active (invalid, shadowed, disabled, or unverified).
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
    keyedCheck('ok', 'skills.label.config', CONFIG_DETAIL_KEYS[diagnostics.config.origin], {
      dir: diagnostics.config.dir,
    }),
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
  const params = { dir: source.dir };

  if (source.health === 'unreadable') {
    // An enabled source that cannot be read hides skills the user expects;
    // a disabled one that is unreadable is only worth noting.
    return source.enabled
      ? keyedCheck('fail', label, 'skills.detail.sourceUnreadable', params)
      : keyedCheck('warn', label, 'skills.detail.sourceUnreadableDisabled', params);
  }
  if (source.health === 'missing') {
    return keyedCheck(
      'ok',
      label,
      source.enabled ? 'skills.detail.sourceMissing' : 'skills.detail.sourceMissingDisabled',
      params
    );
  }
  return keyedCheck(
    'ok',
    label,
    source.enabled ? 'skills.detail.sourceCount' : 'skills.detail.sourceCountDisabled',
    { ...params, count: source.skillCount }
  );
}

function renderSkill(skill: SkillDiagnostic): CheckResult | null {
  const label = 'skills.label.skill';
  const params = { key: skill.key };
  switch (skill.state) {
    case 'invalid':
      // The scan's own sentence about the file; it is not ours to translate.
      return keyedCheck('fail', label, 'skills.detail.invalid', {
        ...params,
        error: skill.error ?? 'invalid skill',
      });
    case 'shadowed':
      return keyedCheck('warn', label, 'skills.detail.shadowed', {
        ...params,
        source: skill.shadowedBy ?? '',
      });
    case 'disabled':
      return keyedCheck('ok', label, 'skills.detail.disabled', params);
    case 'precedence-unverified':
      return keyedCheck('warn', label, 'skills.detail.precedenceUnverified', params);
    default:
      // Active skills are already counted in their source row; no separate line.
      return null;
  }
}
