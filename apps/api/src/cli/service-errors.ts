/**
 * The service manager reports refusals as `RuntimeServiceManagementError`,
 * which carries a kind for callers that branch. The CLI does not branch: it
 * prints the message and exits 1, which is what `CliError` means.
 */

import { RuntimeServiceManagementError } from '@mangostudio/runtime';
import { CliError } from './errors';

/** Run a manager call, turning a refusal into a clean CLI error. // Usage: await withServiceErrors(() => manager.install(def)) */
export async function withServiceErrors<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof RuntimeServiceManagementError) {
      throw new CliError(error.message);
    }
    throw error;
  }
}
