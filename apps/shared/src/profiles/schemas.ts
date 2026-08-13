import Type, { type Static } from 'typebox';

/**
 * Reserved: profiles are not implemented. Every persisted row and request uses
 * this id. If profiles are still unimplemented when this stops earning its
 * keep, delete the seam rather than leaving it as decoration.
 */
export const DEFAULT_PROFILE_ID = 'default' as const;

export const ProfileIdSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
});
export type ProfileId = Static<typeof ProfileIdSchema>;
