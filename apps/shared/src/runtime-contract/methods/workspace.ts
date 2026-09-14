/**
 * The `workspace.browse`, `workspace.validate` and `workspace.resolveContained`
 * method family: exploring and validating filesystem paths on the runtime host.
 *
 * Schema-first, like the families that import it — the schema is the source
 * and the type is `Static<>` of it.
 */

import Type, { type Static } from 'typebox';
import {
  ListDirectoryResponseSchema,
  WorkdirValidationReasonSchema,
} from '../../workspaces/schemas';

export const RuntimeWorkspaceBrowseParamsSchema = Type.Object({
  path: Type.Optional(Type.String()),
});
export type RuntimeWorkspaceBrowseParams = Static<typeof RuntimeWorkspaceBrowseParamsSchema>;

export const RuntimeWorkspaceBrowseResultSchema = ListDirectoryResponseSchema;
export type RuntimeWorkspaceBrowseResult = Static<typeof RuntimeWorkspaceBrowseResultSchema>;

export const RuntimeWorkspaceValidateParamsSchema = Type.Object({
  path: Type.String(),
  requireAbsolute: Type.Optional(Type.Boolean()),
});
export type RuntimeWorkspaceValidateParams = Static<typeof RuntimeWorkspaceValidateParamsSchema>;

export const RuntimeWorkspaceValidateResultSchema = Type.Union([
  Type.Object({ ok: Type.Literal(true), resolvedPath: Type.String() }),
  Type.Object({ ok: Type.Literal(false), reason: WorkdirValidationReasonSchema }),
]);
export type RuntimeWorkspaceValidateResult = Static<typeof RuntimeWorkspaceValidateResultSchema>;

export const RuntimeWorkspaceResolveContainedParamsSchema = Type.Object({
  root: Type.String(),
  /** Root-relative path, in either separator style; the runtime applies its own. */
  path: Type.String(),
});
export type RuntimeWorkspaceResolveContainedParams = Static<
  typeof RuntimeWorkspaceResolveContainedParamsSchema
>;

export const RuntimeWorkspaceResolveContainedResultSchema = Type.Object({
  /** Root-relative canonical path, or null when nothing exists at that location. */
  relativePath: Type.Union([Type.String(), Type.Null()]),
});
export type RuntimeWorkspaceResolveContainedResult = Static<
  typeof RuntimeWorkspaceResolveContainedResultSchema
>;
