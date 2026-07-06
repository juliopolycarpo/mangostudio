import { type Static, Type } from '@sinclair/typebox';

/** Directory-name shape a skill slug must satisfy. */
export const SKILL_SLUG_PATTERN = '^[a-z0-9]+(?:-[a-z0-9]+)*$';
export const SKILL_SLUG_MAX_LENGTH = 64;

/**
 * Where a skill was discovered. Only `mango` (~/.mango/skills) is scanned
 * today; `agents` and `claude` are reserved for third-party skill sources so
 * the `<source>:<slug>` key format never has to migrate.
 */
export const SkillSourceSchema = Type.Union([
  Type.Literal('mango'),
  Type.Literal('agents'),
  Type.Literal('claude'),
]);

export const SkillDescriptorSchema = Type.Object({
  /** Stable identity: `<source>:<slug>`. */
  key: Type.String({ minLength: 1 }),
  /** Directory name under the source's skills dir (may be malformed when invalid). */
  slug: Type.String({ minLength: 1 }),
  name: Type.String(),
  description: Type.String(),
  source: SkillSourceSchema,
  /** Absolute path of the skill directory. */
  path: Type.String({ minLength: 1 }),
  valid: Type.Boolean(),
  enabled: Type.Boolean(),
  /** Why the descriptor was flagged invalid, when `valid` is false. */
  error: Type.Optional(Type.String()),
});

export const SkillListResponseSchema = Type.Object({
  skills: Type.Array(SkillDescriptorSchema),
});

export type SkillSource = Static<typeof SkillSourceSchema>;
export type SkillDescriptor = Static<typeof SkillDescriptorSchema>;
export type SkillListResponse = Static<typeof SkillListResponseSchema>;
