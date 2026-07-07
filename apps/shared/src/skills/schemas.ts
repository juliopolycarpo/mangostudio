import { type Static, Type } from '@sinclair/typebox';

/** Directory-name shape a skill slug must satisfy. */
export const SKILL_SLUG_PATTERN = '^[a-z0-9]+(?:-[a-z0-9]+)*$';
export const SKILL_SLUG_MAX_LENGTH = 64;

/**
 * Where a skill was discovered. `mango` (~/.mango/skills) is always scanned;
 * `agents` and `claude` are opt-in third-party sources toggled through
 * app-settings so the `<source>:<slug>` key format never has to migrate.
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
  /**
   * True when a higher-precedence source provides the same slug. Shadowed
   * skills are still listed so the user can see why their copy is inert, but
   * only the winning descriptor is advertised or loadable.
   */
  shadowed: Type.Boolean(),
  /** Why the descriptor was flagged invalid, when `valid` is false. */
  error: Type.Optional(Type.String()),
});

/**
 * State of one third-party skill source directory, surfaced in the list
 * response so the UI can show whether the toggle is on and whether the
 * directory actually exists on disk.
 */
export const SkillSourceStateSchema = Type.Object({
  enabled: Type.Boolean(),
  path: Type.String(),
  exists: Type.Boolean(),
});

export const SkillSourcesStateSchema = Type.Object({
  agents: SkillSourceStateSchema,
  claude: SkillSourceStateSchema,
});

export const SkillListResponseSchema = Type.Object({
  skills: Type.Array(SkillDescriptorSchema),
  sources: SkillSourcesStateSchema,
});

export const UpdateSkillSettingsBodySchema = Type.Object(
  {
    enabled: Type.Boolean(),
  },
  { additionalProperties: false }
);

export type SkillSource = Static<typeof SkillSourceSchema>;
export type SkillDescriptor = Static<typeof SkillDescriptorSchema>;
export type SkillSourceState = Static<typeof SkillSourceStateSchema>;
export type SkillSourcesState = Static<typeof SkillSourcesStateSchema>;
export type SkillListResponse = Static<typeof SkillListResponseSchema>;
export type UpdateSkillSettingsBody = Static<typeof UpdateSkillSettingsBodySchema>;
