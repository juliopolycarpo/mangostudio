/** Shell names shared by terminal frames and the capability manifest. */
import Type, { type Static } from 'typebox';
export const RuntimeShellKindSchema = Type.Union([
  Type.Literal('bash'),
  Type.Literal('zsh'),
  Type.Literal('powershell'),
]);
export type RuntimeShellKind = Static<typeof RuntimeShellKindSchema>;
