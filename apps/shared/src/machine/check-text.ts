/**
 * Turning a doctor row's keys and params into text in one language.
 *
 * The CLI calls it with the English templates and the machine page with the
 * active locale's, so both read a row the same way and a row keyed by a newer
 * hub than the reader degrades to the English the hub sent instead of to a
 * raw key. Framework-agnostic on purpose: it takes the templates as a value.
 */

import type { MachineCheck } from './schemas';

/** Message templates by wire key, as a locale dictionary holds them. */
export type MachineCheckTemplates = Readonly<Record<string, string | undefined>>;

export interface MachineCheckText {
  readonly label: string;
  readonly detail: string;
}

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * `template` with each `{name}` replaced from `params`, or null when a
 * placeholder has no param. A template written for a newer row shape than the
 * one received (or the reverse) must not print a literal `{name}` at the user;
 * null sends the caller to the English text instead.
 */
function fillTemplate(
  template: string,
  params: Readonly<Record<string, string>> | undefined
): string | null {
  let complete = true;
  const filled = template.replace(PLACEHOLDER, (_match, name: string) => {
    if (params === undefined || !Object.hasOwn(params, name)) {
      complete = false;
      return '';
    }
    return params[name] as string;
  });
  return complete ? filled : null;
}

/** The template for `key`, or undefined for a key this reader does not know. */
function lookupTemplate(templates: MachineCheckTemplates, key: string): string | undefined {
  // Own keys only: a key like `constructor` from a hostile or buggy peer must
  // not resolve to something on the prototype.
  return Object.hasOwn(templates, key) ? templates[key] : undefined;
}

function resolveText(
  key: string | undefined,
  fallback: string,
  templates: MachineCheckTemplates,
  params: MachineCheck['params']
): string {
  if (key === undefined) return fallback;
  const template = lookupTemplate(templates, key);
  if (template === undefined) return fallback;
  return fillTemplate(template, params) ?? fallback;
}

/**
 * The label and detail to show for `check`. Each is rendered from its key when
 * `templates` has one and every placeholder has a param; otherwise it is the
 * check's own English `label` / `detail`.
 *
 * // Usage: resolveMachineCheckText(check, t.environments.machine.doctor.checks)
 */
export function resolveMachineCheckText(
  check: MachineCheck,
  templates: MachineCheckTemplates
): MachineCheckText {
  return {
    label: resolveText(check.labelKey, check.label, templates, check.params),
    detail: resolveText(check.detailKey, check.detail, templates, check.params),
  };
}
