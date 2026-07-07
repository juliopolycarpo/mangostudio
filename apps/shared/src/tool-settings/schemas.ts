import { type Static, Type } from '@sinclair/typebox';
import { ReadonlyArraySchema } from '../schema-helpers';

export const PathListItemSchema = Type.Object({
  path: Type.String(),
  enabled: Type.Boolean(),
});

export type PathListItem = Static<typeof PathListItemSchema>;

const ToolParameterValueSchema = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Array(Type.String()),
  Type.Array(PathListItemSchema),
]);

export const ToolParameterTypeSchema = Type.Union([
  Type.Literal('string'),
  Type.Literal('number'),
  Type.Literal('boolean'),
  Type.Literal('select'),
  Type.Literal('string_list'),
  Type.Literal('path_list'),
]);

export const ToolSettingsCategorySchema = Type.Union([
  Type.Literal('system'),
  Type.Literal('image'),
  Type.Literal('interaction'),
  Type.Literal('mcp'),
]);

export const ToolParameterOptionSchema = Type.Object({
  value: Type.String(),
  label: Type.String(),
});

export const ToolParameterDescriptorSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  label: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String()),
  type: ToolParameterTypeSchema,
  required: Type.Boolean(),
  defaultValue: Type.Optional(ToolParameterValueSchema),
  min: Type.Optional(Type.Number()),
  max: Type.Optional(Type.Number()),
  options: Type.Optional(ReadonlyArraySchema(ToolParameterOptionSchema)),
  /** When set, the frontend renders a catalog-backed model selector. */
  modelType: Type.Optional(Type.Literal('image')),
});

export const ToolParametersSchema = Type.Record(Type.String(), Type.Unknown());

export const ToolSettingsDescriptorSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  description: Type.String(),
  category: ToolSettingsCategorySchema,
  enabled: Type.Boolean(),
  canDisable: Type.Boolean(),
  parameters: ToolParametersSchema,
  parameterDescriptors: ReadonlyArraySchema(ToolParameterDescriptorSchema),
});

export const ToolSettingsListResponseSchema = Type.Object({
  tools: Type.Array(ToolSettingsDescriptorSchema),
});

export const UpdateToolSettingsBodySchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    parameters: Type.Optional(ToolParametersSchema),
  },
  { additionalProperties: false }
);

export type ToolParameterType = Static<typeof ToolParameterTypeSchema>;
export type ToolSettingsCategory = Static<typeof ToolSettingsCategorySchema>;
export type ToolParameterOption = Static<typeof ToolParameterOptionSchema>;
export type ToolParameterDescriptor = Static<typeof ToolParameterDescriptorSchema>;
export type ToolSettingsDescriptor = Static<typeof ToolSettingsDescriptorSchema>;
export type ToolSettingsListResponse = Static<typeof ToolSettingsListResponseSchema>;
export type UpdateToolSettingsBody = Static<typeof UpdateToolSettingsBodySchema>;
