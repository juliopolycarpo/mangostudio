/**
 * Shared serve-time config guard: refuses to start the server when the
 * configured auth secret is missing or too short, surfacing a clean CLI error
 * before any work (spawn, listen) happens.
 */

import { getAuthSecretValidationMessage, getConfig } from '../lib/config';
import { CliError } from './errors';

/** Throws a CliError when the configured auth secret is unusable. // Usage: assertServeConfig() */
export function assertServeConfig(): void {
  const message = getAuthSecretValidationMessage(getConfig().auth.secret);
  if (message) {
    throw new CliError(
      `${message} Set it to a unique random value before running mangostudio serve.`
    );
  }
}
