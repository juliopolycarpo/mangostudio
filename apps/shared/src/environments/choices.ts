import Type, { type Static } from 'typebox';

export const RuntimeIdSchema = Type.Union([
  Type.Literal('bun'),
  Type.Literal('node'),
  Type.Literal('nvm'),
  /** Second helper-managed Node manager; the only one whose install ships on win32. */
  Type.Literal('fnm'),
  /** Probed as a prerequisite for the Windows recipes; never installed by MangoStudio. */
  Type.Literal('winget'),
  /** Probed for the setup checklist and offered as a recipe on win32 only. */
  Type.Literal('git'),
  Type.Literal('mangostudio'),
  Type.Literal('claude'),
  Type.Literal('codex'),
  Type.Literal('cursor'),
]);

export const VersionManagerIdSchema = Type.Union([
  Type.Literal('nvm'),
  Type.Literal('fnm'),
  Type.Literal('volta'),
]);

export type RuntimeId = Static<typeof RuntimeIdSchema>;

export type VersionManagerId = Static<typeof VersionManagerIdSchema>;
