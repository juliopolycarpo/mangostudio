import { ERROR_CODES } from '@mangostudio/shared/errors';
import type {
  ToolSettingsDescriptor,
  ToolSettingsListResponse,
  UpdateToolSettingsBody,
} from '@mangostudio/shared/tool-settings';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import {
  getAllTools,
  getDefaultToolSettings,
  getTool,
  getToolDefinitionForSettings,
  getToolDescriptors,
  mergeToolSettings,
  ToolParameterError,
} from '../../../services/tools/registry';
import type { EffectiveToolSettings, ToolDefinition } from '../../../services/tools/types';
import {
  getSavedToolSettings,
  listSavedToolSettings,
  upsertToolSettings,
} from '../infrastructure/tool-settings-repository';

export class ToolSettingsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
    this.name = 'ToolSettingsError';
  }
}

export interface ToolRuntimeSettings {
  definitions: ToolDefinition[];
  settingsByName: Map<string, EffectiveToolSettings>;
}

export async function listToolSettingsDescriptors(
  db: Kysely<Database>,
  userId: string
): Promise<ToolSettingsListResponse> {
  const savedSettings = await listSavedToolSettings(db, userId);
  return { tools: getToolDescriptors(resolveEffectiveSettings(savedSettings)) };
}

export async function updateToolSettingsDescriptor(
  db: Kysely<Database>,
  userId: string,
  toolName: string,
  updates: UpdateToolSettingsBody
): Promise<ToolSettingsDescriptor> {
  const tool = getTool(toolName);
  if (!tool) {
    throw new ToolSettingsError(`Unknown tool "${toolName}".`, 404, ERROR_CODES.NOT_FOUND);
  }
  if (updates.enabled === false && !tool.settings.canDisable) {
    throw new ToolSettingsError(
      `Tool "${toolName}" cannot be disabled.`,
      422,
      ERROR_CODES.VALIDATION
    );
  }

  const savedSettings = getSafeToolSettings(
    toolName,
    await getSavedToolSettings(db, userId, toolName)
  );
  const nextSettings = validateSettingsUpdate(toolName, savedSettings, updates);
  const persistedSettings = await upsertToolSettings(db, userId, toolName, nextSettings);
  return getToolDescriptors(new Map([[toolName, persistedSettings]])).find(
    (descriptor) => descriptor.name === toolName
  ) as ToolSettingsDescriptor;
}

export async function getEnabledToolRuntime(
  db: Kysely<Database>,
  userId: string
): Promise<ToolRuntimeSettings> {
  const savedSettings = await listSavedToolSettings(db, userId);
  const settingsByName = resolveEffectiveSettings(savedSettings);
  const definitions: ToolDefinition[] = [];

  for (const tool of getAllTools()) {
    const settings = settingsByName.get(tool.definition.name) ?? getDefaultToolSettings(tool);
    const definition = getToolDefinitionForSettings(tool, settings);
    if (definition) definitions.push(definition);
  }

  return { definitions, settingsByName };
}

function validateSettingsUpdate(
  toolName: string,
  savedSettings: EffectiveToolSettings | undefined,
  updates: UpdateToolSettingsBody
): EffectiveToolSettings {
  const tool = getTool(toolName);
  if (!tool) throw new ToolSettingsError(`Unknown tool "${toolName}".`, 404, ERROR_CODES.NOT_FOUND);

  try {
    const merged = mergeToolSettings(tool, savedSettings, updates.parameters);
    return { ...merged, enabled: updates.enabled ?? merged.enabled };
  } catch (error) {
    if (error instanceof ToolParameterError) {
      throw new ToolSettingsError(error.message, 422, ERROR_CODES.VALIDATION);
    }
    throw error;
  }
}

function resolveEffectiveSettings(
  savedSettings: ReadonlyMap<string, EffectiveToolSettings>
): Map<string, EffectiveToolSettings> {
  const effectiveSettings = new Map<string, EffectiveToolSettings>();
  for (const tool of getAllTools()) {
    effectiveSettings.set(
      tool.definition.name,
      getSafeToolSettings(tool.definition.name, savedSettings.get(tool.definition.name)) ??
        getDefaultToolSettings(tool)
    );
  }
  return effectiveSettings;
}

function getSafeToolSettings(
  toolName: string,
  savedSettings: EffectiveToolSettings | undefined
): EffectiveToolSettings | undefined {
  const tool = getTool(toolName);
  if (!tool) return undefined;

  try {
    return mergeToolSettings(tool, savedSettings);
  } catch (error) {
    if (error instanceof ToolParameterError) return getDefaultToolSettings(tool);
    throw error;
  }
}
