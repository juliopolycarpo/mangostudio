import Type, { type Static } from 'typebox';

/** Directory-name shape a skill slug must satisfy. */
export const SKILL_SLUG_PATTERN = '^[a-z0-9]+(?:-[a-z0-9]+)*$';
export const SKILL_SLUG_MAX_LENGTH = 64;

/**
 * Where a skill was discovered. `mango` (~/.mango/skills) is always scanned;
 * `agents` (~/.agents/skills) and `claude` (~/.claude/skills) are opt-in
 * third-party sources toggled through app settings.
 *
 * @deprecated Use `LibraryLocationId` for new library integrations. Existing
 * skill consumers remain on this closed union until their settings migrate.
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
  /** True when a higher-precedence source (mango > agents > claude) owns the slug. */
  shadowed: Type.Boolean(),
  /** Why the descriptor was flagged invalid, when `valid` is false. */
  error: Type.Optional(Type.String()),
});

/** Discovery state of one opt-in third-party skill source directory. */
export const SkillSourceStateSchema = Type.Object({
  enabled: Type.Boolean(),
  /** Absolute path of the source's skills directory. */
  path: Type.String({ minLength: 1 }),
  exists: Type.Boolean(),
});

export const SkillListResponseSchema = Type.Object({
  skills: Type.Array(SkillDescriptorSchema),
  sources: Type.Object({
    agents: SkillSourceStateSchema,
    claude: SkillSourceStateSchema,
  }),
});

export const UpdateSkillSettingsBodySchema = Type.Object({
  enabled: Type.Boolean(),
});

/**
 * @deprecated Use `LibraryLocationId` for new library integrations. Convert
 * legacy values with `SKILL_SOURCE_TO_LOCATION_ID`.
 */
export type SkillSource = Static<typeof SkillSourceSchema>;
export type SkillDescriptor = Static<typeof SkillDescriptorSchema>;
export type SkillSourceState = Static<typeof SkillSourceStateSchema>;
export type SkillListResponse = Static<typeof SkillListResponseSchema>;
export type UpdateSkillSettingsBody = Static<typeof UpdateSkillSettingsBodySchema>;
