/**
 * The English doctor templates, for code that has no `useI18n` (the CLI and the
 * API's row builder). Its own subpath, kept out of the `machine` barrel: the
 * browser imports that barrel, and the English dictionary must reach it only
 * through the Environments chunk.
 */

import { messages } from '../i18n/en-environments';
import { type MachineCheckText, resolveMachineCheckText } from './check-text';
import type { MachineCheck } from './schemas';

/** Every English doctor template by wire key. */
export const MACHINE_CHECK_TEMPLATES_EN = messages.environments.machine.doctor.checks;

/** A wire key the hub can attach to a row: one of the English templates. */
export type MachineCheckKey = keyof typeof MACHINE_CHECK_TEMPLATES_EN;

/**
 * The English text of a row, built from its keys so the CLI never prints prose
 * the keys do not describe. A row without keys prints its own `label` / `detail`.
 */
export function renderMachineCheckEnglish(check: MachineCheck): MachineCheckText {
  return resolveMachineCheckText(check, MACHINE_CHECK_TEMPLATES_EN);
}
