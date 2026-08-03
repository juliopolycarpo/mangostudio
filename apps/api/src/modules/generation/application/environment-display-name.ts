/**
 * Resolves the display name of a chat's environment for capability refusal
 * copy. Local is always "Local"; remote rows use the stored name.
 */

import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { environmentRepository } from '../../environments/infrastructure/environment-repository';

/** // Usage: const name = await resolveEnvironmentDisplayName(userId, chat.environmentId) */
export async function resolveEnvironmentDisplayName(
  userId: string,
  environmentId: string
): Promise<string> {
  if (environmentId === LOCAL_ENVIRONMENT_ID) return 'Local';
  const record = await environmentRepository.find(userId, environmentId);
  return record?.name ?? environmentId;
}
