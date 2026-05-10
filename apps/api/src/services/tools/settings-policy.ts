import type {
  ToolParameterDescriptor,
  ToolSettingsDescriptor,
} from '@mangostudio/shared/tool-settings';
import type { EffectiveToolSettings, RegisteredTool, ToolDefinition } from './types';

export class ToolParameterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolParameterError';
  }
}

export function getDefaultToolSettings(tool: RegisteredTool): EffectiveToolSettings {
  return {
    enabled: tool.settings.enabledByDefault,
    parameters: normalizeToolParameters(tool, tool.settings.defaultParameters),
  };
}

export function mergeToolSettings(
  tool: RegisteredTool,
  savedSettings?: Partial<EffectiveToolSettings>,
  parameterUpdates?: Record<string, unknown>
): EffectiveToolSettings {
  const defaults = getDefaultToolSettings(tool);
  const enabled = savedSettings?.enabled ?? defaults.enabled;
  const parameters = normalizeToolParameters(tool, {
    ...defaults.parameters,
    ...(savedSettings?.parameters ?? {}),
    ...(parameterUpdates ?? {}),
  });

  return { enabled, parameters };
}

export function getToolDescriptorsForTools(
  tools: ReadonlyArray<RegisteredTool>,
  settingsByToolName: ReadonlyMap<string, EffectiveToolSettings> = new Map()
): ToolSettingsDescriptor[] {
  return tools.map((tool) =>
    buildToolDescriptor(tool, settingsByToolName.get(tool.definition.name))
  );
}

export function getToolDefinitionForSettings(
  tool: RegisteredTool,
  settings: EffectiveToolSettings
): ToolDefinition | null {
  return settings.enabled ? (tool.buildDefinition?.(settings) ?? tool.definition) : null;
}

export function getToolDefinitionsForTools(
  tools: ReadonlyArray<RegisteredTool>,
  settingsByToolName: ReadonlyMap<string, EffectiveToolSettings> = new Map()
): ToolDefinition[] {
  return tools
    .map((tool) =>
      getToolDefinitionForSettings(
        tool,
        getSafeEffectiveToolSettings(tool, settingsByToolName.get(tool.definition.name))
      )
    )
    .filter((definition): definition is ToolDefinition => definition !== null);
}

export function normalizeToolParameters(
  tool: RegisteredTool,
  parameters: Record<string, unknown>
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  const descriptors = new Map(
    tool.settings.parameterDescriptors.map((descriptor) => [descriptor.name, descriptor])
  );

  for (const name of Object.keys(parameters)) {
    if (!descriptors.has(name)) {
      throw new ToolParameterError(
        `Unknown parameter "${name}" for tool "${tool.definition.name}".`
      );
    }
  }

  for (const descriptor of tool.settings.parameterDescriptors) {
    const value = parameters[descriptor.name] ?? descriptor.defaultValue;
    if (value === undefined) {
      if (descriptor.required) {
        throw new ToolParameterError(
          `Missing required parameter "${descriptor.name}" for tool "${tool.definition.name}".`
        );
      }
      continue;
    }
    normalized[descriptor.name] = normalizeParameterValue(tool, descriptor, value);
  }

  return normalized;
}

export function getSafeEffectiveToolSettings(
  tool: RegisteredTool,
  settings: EffectiveToolSettings | undefined
): EffectiveToolSettings {
  try {
    return mergeToolSettings(tool, settings);
  } catch (error) {
    if (error instanceof ToolParameterError) return getDefaultToolSettings(tool);
    throw error;
  }
}

function buildToolDescriptor(
  tool: RegisteredTool,
  settings?: EffectiveToolSettings
): ToolSettingsDescriptor {
  const effectiveSettings = getSafeEffectiveToolSettings(tool, settings);

  return {
    name: tool.definition.name,
    title: tool.settings.title,
    description: tool.settings.description,
    category: tool.settings.category,
    enabled: effectiveSettings.enabled,
    canDisable: tool.settings.canDisable,
    parameters: effectiveSettings.parameters,
    parameterDescriptors: [...tool.settings.parameterDescriptors],
  };
}

function normalizeParameterValue(
  tool: RegisteredTool,
  descriptor: ToolParameterDescriptor,
  value: unknown
): string | number | boolean | string[] | Array<{ path: string; enabled: boolean }> {
  if (descriptor.type === 'select') return normalizeSelectValue(tool, descriptor, value);
  if (descriptor.type === 'number') return normalizeNumberValue(tool, descriptor, value);
  if (descriptor.type === 'string' && typeof value === 'string') return value;
  if (descriptor.type === 'boolean' && typeof value === 'boolean') return value;
  if (descriptor.type === 'string_list') return normalizeStringListValue(tool, descriptor, value);
  if (descriptor.type === 'path_list') return normalizePathListValue(tool, descriptor, value);

  throw new ToolParameterError(
    `Parameter "${descriptor.name}" for tool "${tool.definition.name}" must be ${descriptor.type}.`
  );
}

function normalizeSelectValue(
  tool: RegisteredTool,
  descriptor: ToolParameterDescriptor,
  value: unknown
): string {
  if (typeof value !== 'string') {
    throw new ToolParameterError(
      `Parameter "${descriptor.name}" for tool "${tool.definition.name}" must be a string option.`
    );
  }

  const allowedValues = new Set(descriptor.options?.map((option) => option.value) ?? []);
  if (allowedValues.size > 0 && !allowedValues.has(value)) {
    throw new ToolParameterError(
      `Parameter "${descriptor.name}" for tool "${tool.definition.name}" has an unsupported option.`
    );
  }
  return value;
}

function normalizeNumberValue(
  tool: RegisteredTool,
  descriptor: ToolParameterDescriptor,
  value: unknown
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ToolParameterError(
      `Parameter "${descriptor.name}" for tool "${tool.definition.name}" must be a finite number.`
    );
  }
  if (descriptor.min !== undefined && value < descriptor.min) {
    throw new ToolParameterError(
      `Parameter "${descriptor.name}" for tool "${tool.definition.name}" must be at least ${descriptor.min}.`
    );
  }
  if (descriptor.max !== undefined && value > descriptor.max) {
    throw new ToolParameterError(
      `Parameter "${descriptor.name}" for tool "${tool.definition.name}" must be at most ${descriptor.max}.`
    );
  }
  return value;
}

function normalizeStringListValue(
  tool: RegisteredTool,
  descriptor: ToolParameterDescriptor,
  value: unknown
): string[] {
  if (Array.isArray(value)) {
    const strings = value.filter((item): item is string => typeof item === 'string');
    if (strings.length !== value.length) {
      throw new ToolParameterError(
        `Parameter "${descriptor.name}" for tool "${tool.definition.name}" must be an array of strings.`
      );
    }
    return strings.map((s) => s.trim()).filter((s) => s.length > 0);
  }
  if (typeof value === 'string') {
    return value
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  throw new ToolParameterError(
    `Parameter "${descriptor.name}" for tool "${tool.definition.name}" must be a string list.`
  );
}

function normalizePathListValue(
  tool: RegisteredTool,
  descriptor: ToolParameterDescriptor,
  value: unknown
): Array<{ path: string; enabled: boolean }> {
  if (Array.isArray(value)) {
    const items: Array<{ path: string; enabled: boolean }> = [];
    for (const raw of value) {
      if (
        typeof raw === 'object' &&
        raw !== null &&
        'path' in raw &&
        typeof (raw as Record<string, unknown>).path === 'string' &&
        'enabled' in raw &&
        typeof (raw as Record<string, unknown>).enabled === 'boolean'
      ) {
        const entry = raw as { path: string; enabled: boolean };
        const trimmed = entry.path.trim();
        if (trimmed.length > 0) {
          items.push({ path: trimmed, enabled: entry.enabled });
        }
      } else {
        throw new ToolParameterError(
          `Parameter "${descriptor.name}" for tool "${tool.definition.name}" must be an array of path items.`
        );
      }
    }
    return items;
  }
  if (typeof value === 'string') {
    return value
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((path) => ({ path, enabled: true }));
  }
  throw new ToolParameterError(
    `Parameter "${descriptor.name}" for tool "${tool.definition.name}" must be a path list.`
  );
}
