export type ToolParameterType = 'string' | 'number' | 'boolean' | 'select' | 'string_list';

export type ToolSettingsCategory = 'system' | 'image' | 'interaction';

export interface ToolParameterOption {
  value: string;
  label: string;
}

export interface ToolParameterDescriptor {
  name: string;
  label: string;
  description?: string;
  type: ToolParameterType;
  required: boolean;
  defaultValue?: string | number | boolean | string[];
  min?: number;
  max?: number;
  options?: ReadonlyArray<ToolParameterOption>;
  /** When set, the frontend renders a catalog-backed model selector. */
  modelType?: 'image';
}

export interface ToolSettingsDescriptor {
  name: string;
  title: string;
  description: string;
  category: ToolSettingsCategory;
  enabled: boolean;
  canDisable: boolean;
  parameters: Record<string, unknown>;
  parameterDescriptors: ReadonlyArray<ToolParameterDescriptor>;
}

export interface ToolSettingsListResponse {
  tools: ToolSettingsDescriptor[];
}
