/**
 * The filesystem family: reading, writing and patching files through the
 * runtime, plus directory listing, glob and grep.
 *
 * Schema-first, like the other families in this directory — the schema is the
 * source and the type is `Static<>` of it.
 */

import Type, { type Static } from 'typebox';
import { ReadonlyArraySchema } from '../../schema-helpers';
import { RuntimePathPolicyParamsSchema } from '../path-policy';
import { RuntimeMutationParamsSchema } from './common';

/**
 * How a file's bytes are rendered into the string the model receives. `text`
 * decodes as UTF-8 and refuses anything holding a NUL byte; `hex` and `base64`
 * transcode the bytes verbatim, which is the only way a binary file can enter
 * the freshness ledger and so the only way it can be overwritten through the
 * read-before-write guard. Absent means `text`.
 *
 * The schema is the source of truth and the list is derived from it: the hub
 * needs the values at runtime for its argument check and its JSON-schema `enum`,
 * and a list written separately would let a view added here compile cleanly
 * while the hub silently refused it.
 *
 * Derived in this direction rather than the other because a `Type.Union` built
 * by mapping over a plain array infers `never` — the array is not a tuple, so
 * TypeScript has nothing to distribute over. `RUNTIME_SLOTS` in
 * `runtime-home/schemas.ts` derives the same way for the same reason.
 */
export const RuntimeReadFileViewSchema = Type.Union([
  Type.Literal('text'),
  Type.Literal('hex'),
  Type.Literal('base64'),
]);
export type RuntimeReadFileView = Static<typeof RuntimeReadFileViewSchema>;

export const RUNTIME_READ_FILE_VIEWS = RuntimeReadFileViewSchema.anyOf.map(
  (member) => member.const
) as readonly RuntimeReadFileView[];

export const RuntimeReadFileParamsSchema = Type.Interface([RuntimePathPolicyParamsSchema], {
  chatId: Type.String(),
  inputPath: Type.String(),
  resolvedPath: Type.String(),
  startLine: Type.Optional(Type.Number()),
  maxLines: Type.Optional(Type.Number()),
  /** Absent means `text`; the line window applies to `text` only. */
  view: Type.Optional(RuntimeReadFileViewSchema),
});
export type RuntimeReadFileParams = Static<typeof RuntimeReadFileParamsSchema>;

export const RuntimeReadFileResultSchema = Type.Object({
  content: Type.String(),
  path: Type.String(),
  size: Type.Number(),
  sha256: Type.String(),
  totalLines: Type.Number(),
  startLine: Type.Number(),
  endLine: Type.Number(),
  truncated: Type.Boolean(),
  /**
   * Echoed only for a byte view, so a `text` result keeps the shape it has
   * always had and the model can tell a hex dump from file content.
   */
  view: Type.Optional(Type.Exclude(RuntimeReadFileViewSchema, Type.Literal('text'))),
});
export type RuntimeReadFileResult = Static<typeof RuntimeReadFileResultSchema>;

export const RuntimeWriteFileParamsSchema = Type.Interface([RuntimeMutationParamsSchema], {
  inputPath: Type.String(),
  resolvedPath: Type.String(),
  content: Type.String(),
});
export type RuntimeWriteFileParams = Static<typeof RuntimeWriteFileParamsSchema>;

export const RuntimeWriteFileResultSchema = Type.Object({
  path: Type.String(),
  bytesWritten: Type.Number(),
  created: Type.Boolean(),
  sha256: Type.String(),
});
export type RuntimeWriteFileResult = Static<typeof RuntimeWriteFileResultSchema>;

export const RuntimeCreateFileParamsSchema = Type.Interface([RuntimeMutationParamsSchema], {
  inputPath: Type.String(),
  resolvedPath: Type.String(),
  content: Type.String(),
});
export type RuntimeCreateFileParams = Static<typeof RuntimeCreateFileParamsSchema>;

export const RuntimeCreateFileResultSchema = Type.Object({
  path: Type.String(),
  bytesWritten: Type.Number(),
  sha256: Type.String(),
});
export type RuntimeCreateFileResult = Static<typeof RuntimeCreateFileResultSchema>;

export const RuntimeEditFileParamsSchema = Type.Interface([RuntimeMutationParamsSchema], {
  inputPath: Type.String(),
  resolvedPath: Type.String(),
  oldString: Type.String(),
  newString: Type.String(),
  replaceAll: Type.Optional(Type.Boolean()),
});
export type RuntimeEditFileParams = Static<typeof RuntimeEditFileParamsSchema>;

export const RuntimeEditFileResultSchema = Type.Object({
  path: Type.String(),
  replacements: Type.Number(),
  sha256: Type.String(),
  firstChangedLine: Type.Number(),
});
export type RuntimeEditFileResult = Static<typeof RuntimeEditFileResultSchema>;

export const RuntimeReplaceRangeParamsSchema = Type.Interface([RuntimeMutationParamsSchema], {
  inputPath: Type.String(),
  resolvedPath: Type.String(),
  startLine: Type.Number(),
  endLine: Type.Number(),
  content: Type.String(),
});
export type RuntimeReplaceRangeParams = Static<typeof RuntimeReplaceRangeParamsSchema>;

export const RuntimeReplaceRangeResultSchema = Type.Object({
  path: Type.String(),
  replacedLines: Type.Number(),
  newTotalLines: Type.Number(),
  sha256: Type.String(),
});
export type RuntimeReplaceRangeResult = Static<typeof RuntimeReplaceRangeResultSchema>;

export const RuntimeDeleteFileParamsSchema = Type.Interface([RuntimeMutationParamsSchema], {
  inputPath: Type.String(),
  resolvedPath: Type.String(),
});
export type RuntimeDeleteFileParams = Static<typeof RuntimeDeleteFileParamsSchema>;

export const RuntimeDeleteFileResultSchema = Type.Object({
  path: Type.String(),
  deleted: Type.Literal(true),
});
export type RuntimeDeleteFileResult = Static<typeof RuntimeDeleteFileResultSchema>;

export const RuntimeMoveFileParamsSchema = Type.Interface([RuntimeMutationParamsSchema], {
  inputFrom: Type.String(),
  inputTo: Type.String(),
  resolvedFrom: Type.String(),
  resolvedTo: Type.String(),
});
export type RuntimeMoveFileParams = Static<typeof RuntimeMoveFileParamsSchema>;

export const RuntimeMoveFileResultSchema = Type.Object({
  from: Type.String(),
  to: Type.String(),
  moved: Type.Literal(true),
});
export type RuntimeMoveFileResult = Static<typeof RuntimeMoveFileResultSchema>;

export const RuntimeListDirectoryParamsSchema = Type.Interface([RuntimePathPolicyParamsSchema], {
  inputPath: Type.String(),
  resolvedPath: Type.String(),
});
export type RuntimeListDirectoryParams = Static<typeof RuntimeListDirectoryParamsSchema>;

export const RuntimeListDirectoryResultSchema = Type.Object({
  path: Type.String(),
  entries: ReadonlyArraySchema(
    Type.Object({
      name: Type.String(),
      type: Type.Union([Type.Literal('file'), Type.Literal('directory')]),
    })
  ),
});
export type RuntimeListDirectoryResult = Static<typeof RuntimeListDirectoryResultSchema>;

export const RuntimeGlobParamsSchema = Type.Interface([RuntimePathPolicyParamsSchema], {
  pattern: Type.String(),
  cwd: Type.String(),
  maxResults: Type.Number(),
  includeDotfiles: Type.Boolean(),
  absolute: Type.Boolean(),
});
export type RuntimeGlobParams = Static<typeof RuntimeGlobParamsSchema>;

export const RuntimeGlobResultSchema = Type.Object({
  pattern: Type.String(),
  cwd: Type.String(),
  matches: ReadonlyArraySchema(Type.String()),
  truncated: Type.Boolean(),
});
export type RuntimeGlobResult = Static<typeof RuntimeGlobResultSchema>;

export const RuntimeGrepParamsSchema = Type.Interface([RuntimePathPolicyParamsSchema], {
  pattern: Type.String(),
  inputPath: Type.String(),
  resolvedPath: Type.String(),
  glob: Type.Optional(Type.String()),
  caseInsensitive: Type.Boolean(),
  maxResults: Type.Number(),
  maxMatchesPerFile: Type.Number(),
  maxFileSizeBytes: Type.Number(),
  includeDotfiles: Type.Boolean(),
});
export type RuntimeGrepParams = Static<typeof RuntimeGrepParamsSchema>;

export const RuntimeGrepResultSchema = Type.Object({
  pattern: Type.String(),
  path: Type.String(),
  matches: ReadonlyArraySchema(
    Type.Object({
      file: Type.String(),
      line: Type.Number(),
      text: Type.String(),
    })
  ),
  filesScanned: Type.Number(),
  truncated: Type.Boolean(),
});
export type RuntimeGrepResult = Static<typeof RuntimeGrepResultSchema>;

export const RuntimePatchHunkLineSchema = Type.Object({
  type: Type.Union([Type.Literal('context'), Type.Literal('add'), Type.Literal('delete')]),
  content: Type.String(),
  ending: Type.Union([Type.Literal(''), Type.Literal('\n'), Type.Literal('\r\n')]),
});
export type RuntimePatchHunkLine = Static<typeof RuntimePatchHunkLineSchema>;

export const RuntimePatchHunkSchema = Type.Object({
  marker: Type.Optional(Type.String()),
  lines: ReadonlyArraySchema(RuntimePatchHunkLineSchema),
});
export type RuntimePatchHunk = Static<typeof RuntimePatchHunkSchema>;

export const RuntimePatchOperationSchema = Type.Union([
  Type.Object({
    type: Type.Literal('add'),
    inputPath: Type.String(),
    resolvedPath: Type.String(),
    content: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('delete'),
    inputPath: Type.String(),
    resolvedPath: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('update'),
    inputPath: Type.String(),
    resolvedPath: Type.String(),
    moveTo: Type.Optional(Type.String()),
    resolvedMoveTo: Type.Optional(Type.String()),
    hunks: ReadonlyArraySchema(RuntimePatchHunkSchema),
  }),
]);
export type RuntimePatchOperation = Static<typeof RuntimePatchOperationSchema>;

export const RuntimeApplyPatchParamsSchema = Type.Interface([RuntimeMutationParamsSchema], {
  operations: ReadonlyArraySchema(RuntimePatchOperationSchema),
});
export type RuntimeApplyPatchParams = Static<typeof RuntimeApplyPatchParamsSchema>;

export const RuntimeApplyPatchResultSchema = Type.Object({
  files: ReadonlyArraySchema(
    Type.Object({
      path: Type.String(),
      op: Type.Union([
        Type.Literal('add'),
        Type.Literal('update'),
        Type.Literal('delete'),
        Type.Literal('move'),
      ]),
      movedTo: Type.Optional(Type.String()),
      sha256: Type.Optional(Type.String()),
    })
  ),
  summary: Type.String(),
});
export type RuntimeApplyPatchResult = Static<typeof RuntimeApplyPatchResultSchema>;
