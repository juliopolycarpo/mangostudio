import { Type, type Static } from '@sinclair/typebox';

export const FixedRuleFileKindSchema = Type.Union([Type.Literal('agents'), Type.Literal('claude')]);

export const RuleFileDescriptorSchema = Type.Object({
  kind: Type.Optional(FixedRuleFileKindSchema),
  label: Type.String(),
  path: Type.String(),
  exists: Type.Boolean(),
  readable: Type.Boolean(),
  sizeBytes: Type.Optional(Type.Integer({ minimum: 0 })),
  error: Type.Optional(Type.String()),
});

export const RuleFilePreviewBodySchema = Type.Object({
  path: Type.String({ minLength: 1 }),
});

export const RuleFilePreviewResponseSchema = Type.Composite([
  RuleFileDescriptorSchema,
  Type.Object({
    content: Type.Optional(Type.String()),
    truncated: Type.Boolean(),
  }),
]);

export const DefaultRuleFilesResponseSchema = Type.Object({
  files: Type.Array(RuleFileDescriptorSchema),
});

export type FixedRuleFileKind = Static<typeof FixedRuleFileKindSchema>;
export type RuleFileDescriptor = Static<typeof RuleFileDescriptorSchema>;
export type RuleFilePreviewBody = Static<typeof RuleFilePreviewBodySchema>;
export type RuleFilePreviewResponse = Static<typeof RuleFilePreviewResponseSchema>;
