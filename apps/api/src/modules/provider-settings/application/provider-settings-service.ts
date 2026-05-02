import type { Kysely } from 'kysely';
import type {
  ProviderRuntimeSettings,
  ProviderSettingsDescriptor,
  ProviderSettingsListResponse,
  UpdateProviderRuntimeSettingsBody,
} from '@mangostudio/shared/provider-settings';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import type { ProviderType } from '@mangostudio/shared/types';
import type { Database } from '../../../db/types';
import { listRegisteredProviderTypes } from '../../../services/providers/registry';
import {
  buildProviderSettingsDescriptor,
  isProviderType,
  mergeProviderRuntimeSettings,
} from '../../../services/providers/core/provider-settings-policy';
import {
  getProviderSettings,
  listProviderSettings,
  upsertProviderSettings,
} from '../infrastructure/provider-settings-repository';

export class ProviderSettingsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
    this.name = 'ProviderSettingsError';
  }
}

export function parseProviderParam(value: string): ProviderType {
  if (isProviderType(value)) return value;
  throw new ProviderSettingsError(`Unknown provider "${value}".`, 422, ERROR_CODES.VALIDATION);
}

export async function listProviderSettingsDescriptors(
  db: Kysely<Database>,
  userId: string
): Promise<ProviderSettingsListResponse> {
  const savedSettings = await listProviderSettings(db, userId);
  return {
    providers: listRegisteredProviderTypes().map((provider) =>
      buildProviderSettingsDescriptor(provider, savedSettings.get(provider))
    ),
  };
}

export async function getProviderSettingsDescriptor(
  db: Kysely<Database>,
  userId: string,
  provider: ProviderType
): Promise<ProviderSettingsDescriptor> {
  assertRegisteredProvider(provider);
  const savedSettings = await getProviderSettings(db, userId, provider);
  return buildProviderSettingsDescriptor(provider, savedSettings);
}

export async function updateProviderSettingsDescriptor(
  db: Kysely<Database>,
  userId: string,
  provider: ProviderType,
  updates: UpdateProviderRuntimeSettingsBody
): Promise<ProviderSettingsDescriptor> {
  assertRegisteredProvider(provider);
  const savedSettings = await getProviderSettings(db, userId, provider);
  const nextSettings = mergeProviderRuntimeSettings(provider, savedSettings, {
    ...updates,
    provider,
  } satisfies Partial<ProviderRuntimeSettings>);
  const persistedSettings = await upsertProviderSettings(db, userId, provider, nextSettings);
  return buildProviderSettingsDescriptor(provider, persistedSettings);
}

function assertRegisteredProvider(provider: ProviderType): void {
  if (listRegisteredProviderTypes().includes(provider)) return;
  throw new ProviderSettingsError(
    `Provider "${provider}" is not registered.`,
    404,
    ERROR_CODES.NOT_FOUND
  );
}
