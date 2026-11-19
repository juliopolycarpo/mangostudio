/**
 * The English doctor templates, for code that has no `useI18n` (the CLI and the
 * API's row builder). Its own subpath, kept out of the `machine` barrel: the
 * browser imports that barrel, and the English dictionary must reach it only
 * through the Environments chunk.
 */

import { messages as coreEn } from '../i18n/en';
import { messages } from '../i18n/en-environments';
import {
  type MachineCheckText,
  type MachineCheckValueLabels,
  resolveMachineCheckText,
} from './check-text';
import type { MachineCheck } from './schemas';

/** The English templates the doctor owns, by wire key. */
export const MACHINE_DOCTOR_TEMPLATES_EN = messages.environments.machine.doctor.checks;

/**
 * Every English template a row can be keyed by: the doctor's own, and the
 * runtime finding sentences, which an environments row sends under the
 * finding's code (`not-found`, `outdated-lts`) so the product has one wording
 * of each finding.
 */
export const MACHINE_CHECK_TEMPLATES_EN = {
  ...MACHINE_DOCTOR_TEMPLATES_EN,
  ...coreEn.environments.findings,
};

/** The English words for the params that carry a code: an LTS status in a finding. */
export const MACHINE_CHECK_VALUE_LABELS_EN: MachineCheckValueLabels = {
  ltsStatus: coreEn.environments.lts,
};

/** A wire key the hub can attach to a row: one of the English templates. */
export type MachineCheckKey = keyof typeof MACHINE_CHECK_TEMPLATES_EN;

/**
 * The English text of a row, built from its keys so the CLI never prints prose
 * the keys do not describe. A row without keys prints its own `label` / `detail`.
 */
export function renderMachineCheckEnglish(check: MachineCheck): MachineCheckText {
  return resolveMachineCheckText(check, MACHINE_CHECK_TEMPLATES_EN, MACHINE_CHECK_VALUE_LABELS_EN);
}
