import { ERROR_CODES } from '@mangostudio/shared/errors';
import type {
  ToolSettingsDescriptor,
  ToolSettingsListResponse,
  UpdateToolSettingsBody,
} from '@mangostudio/shared/tool-settings';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import {
  getMcpServerRowBySlug,
  listMcpBridgeTools,
  type McpBridgeTool,
} from '../../../services/mcp/tool-bridge';
import { isMcpToolName, parseMcpToolName } from '../../../services/mcp/tool-naming';
import { publishSettingsInvalidation } from '../../../services/realtime/settings-invalidation';
import {
  getAllTools,
  getDefaultToolSettings,
  getTool,
  getToolDescriptors,
  mergeToolSettings,
  ToolParameterError,
} from '../../../services/tools/registry';
import type { EffectiveToolSettings } from '../../../services/tools/types';
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

export async function listToolSettingsDescriptors(
  db: Kysely<Database>,
  userId: string
): Promise<ToolSettingsListResponse> {
  const [savedSettings, mcpTools] = await Promise.all([
    listSavedToolSettings(db, userId),
    listMcpBridgeTools(db, userId),
  ]);
  return {
    tools: [
      ...getToolDescriptors(resolveEffectiveSettings(savedSettings)),
      ...mcpTools.map((tool) => buildMcpToolDescriptor(tool, savedSettings.get(tool.name))),
    ],
  };
}

export async function updateToolSettingsDescriptor(
  db: Kysely<Database>,
  userId: string,
  toolName: string,
  updates: UpdateToolSettingsBody
): Promise<ToolSettingsDescriptor> {
  const descriptor = await writeToolSettings(db, userId, toolName, updates);
  publishSettingsInvalidation(userId, 'tool');
  return descriptor;
}

/** Both branches persist to `user_tool_settings`; only the validation differs. */
async function writeToolSettings(
  db: Kysely<Database>,
  userId: string,
  toolName: string,
  updates: UpdateToolSettingsBody
): Promise<ToolSettingsDescriptor> {
  if (isMcpToolName(toolName)) {
    return updateMcpToolSettings(db, userId, toolName, updates);
  }
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

/**
 * MCP tools have no parameters — only the enabled toggle persists, keyed by
 * the namespaced name in the same `user_tool_settings` table as builtins.
 * The tool itself is not required to be listable right now (the server may be
 * offline); only server ownership gates the write.
 */
async function updateMcpToolSettings(
  db: Kysely<Database>,
  userId: string,
  toolName: string,
  updates: UpdateToolSettingsBody
): Promise<ToolSettingsDescriptor> {
  const parsed = parseMcpToolName(toolName);
  const server = parsed && (await getMcpServerRowBySlug(db, userId, parsed.serverSlug));
  if (!parsed || !server) {
    throw new ToolSettingsError(`Unknown tool "${toolName}".`, 404, ERROR_CODES.NOT_FOUND);
  }
  if (updates.parameters && Object.keys(updates.parameters).length > 0) {
    throw new ToolSettingsError(
      `Tool "${toolName}" has no configurable parameters.`,
      422,
      ERROR_CODES.VALIDATION
    );
  }

  const savedSettings = await getSavedToolSettings(db, userId, toolName);
  const nextSettings: EffectiveToolSettings = {
    enabled: updates.enabled ?? savedSettings?.enabled ?? true,
    parameters: {},
  };
  const persistedSettings = await upsertToolSettings(db, userId, toolName, nextSettings);
  return buildMcpToolDescriptor(
    {
      name: toolName,
      serverName: server.name,
      serverSlug: parsed.serverSlug,
      toolName: parsed.toolName,
      definition: { name: toolName, description: '', parameters: {} },
    },
    persistedSettings
  );
}

function buildMcpToolDescriptor(
  tool: McpBridgeTool,
  savedSettings: EffectiveToolSettings | undefined
): ToolSettingsDescriptor {
  return {
    name: tool.name,
    title: `${tool.serverName}: ${tool.toolName}`,
    description: tool.definition.description,
    category: 'mcp',
    enabled: savedSettings?.enabled ?? true,
    canDisable: true,
    parameters: {},
    parameterDescriptors: [],
  };
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
