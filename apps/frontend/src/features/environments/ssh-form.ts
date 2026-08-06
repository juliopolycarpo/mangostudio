/**
 * Shared SSH form → config helpers for the add dialog and the environment card.
 *
 * Kept in one place because the two UIs already diverged once on port parsing
 * (`Number(...)` vs `/^\d+$/`), and a leading-dash check that only one of them
 * ran would let a value the schema refuses look submitable.
 */

import type { SshEnvironmentConfig } from '@mangostudio/shared/environments';

/** Mirrors `SshArgumentValueSchema`; the server is still the authority. */
export const SSH_LEADING_DASH = /^-/;

export interface SshFormFields {
  readonly host: string;
  readonly user: string;
  readonly port: string;
  readonly identityFile: string;
  readonly remoteRuntimePath: string;
}

export type SshFormField = keyof SshFormFields;

/** Every field blank — "not set", never an empty argv entry. */
export function emptySshForm(): SshFormFields {
  return { host: '', user: '', port: '', identityFile: '', remoteRuntimePath: '' };
}

/** The form as the transport sees it: empty means "not set", never an empty argv entry. */
export function sshFormToConfig(form: SshFormFields): SshEnvironmentConfig {
  // Only a wholly numeric value becomes a port: `Number.parseInt` would
  // silently accept `22abc` as 22 and store something nobody typed.
  const rawPort = form.port.trim();
  const port = /^\d+$/.test(rawPort) ? Number(rawPort) : Number.NaN;
  return {
    host: form.host.trim(),
    ...(form.user.trim() ? { user: form.user.trim() } : {}),
    ...(Number.isFinite(port) ? { port } : {}),
    ...(form.identityFile.trim() ? { identityFile: form.identityFile.trim() } : {}),
    ...(form.remoteRuntimePath.trim() ? { remoteRuntimePath: form.remoteRuntimePath.trim() } : {}),
  };
}

/**
 * The one field that must be there, the range a port has, and the shape the
 * transport refuses outright everywhere. A leading dash is caught here rather
 * than only server-side because the value it would become — an ssh option
 * instead of an argument — deserves a message beside the field that produced
 * it.
 */
export function validateSshForm(form: SshFormFields): SshFormField | null {
  const host = form.host.trim();
  if (host.length === 0 || SSH_LEADING_DASH.test(host)) return 'host';
  for (const field of ['user', 'identityFile', 'remoteRuntimePath'] as const) {
    if (SSH_LEADING_DASH.test(form[field].trim())) return field;
  }
  const port = form.port.trim();
  if (port.length === 0) return null;
  if (!/^\d+$/.test(port)) return 'port';
  const parsed = Number(port);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? null : 'port';
}

export function isSshFormUsable(form: SshFormFields): boolean {
  return validateSshForm(form) === null && form.host.trim().length > 0;
}
