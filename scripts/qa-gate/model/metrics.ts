// Value schemas for every QA metric plus the v4 `Metrics` document. Public
// types are derived with `Static<>`; nothing here is hand-written twice.
//
// Every count is a non-negative integer, and the refinements reject documents
// whose numbers contradict each other (covered > total, a percentage for a
// zero denominator, LoC that do not add up). The publisher validates untrusted
// artifact JSON against these, so every string and array carries a bound.

import Type, { type Static } from 'typebox';

import { measurement } from './states';

const count = Type.Integer({ minimum: 0 });
const boundedNumber = Type.Number({ minimum: 0 });

const pctMatches = (covered: number, total: number, pct: number): boolean =>
  Math.abs(pct - (covered / total) * 100) <= 0.01;

/** Coverage bucket: `pct` is null exactly when the denominator is zero (n/a). */
const CoverageBucketSchema = Type.Refine(
  Type.Object(
    {
      total: count,
      covered: count,
      pct: Type.Union([Type.Number({ minimum: 0, maximum: 100 }), Type.Null()]),
    },
    { additionalProperties: false }
  ),
  (bucket) => {
    if (bucket.covered > bucket.total) return false;
    if (bucket.total === 0) return bucket.pct === null;
    return bucket.pct !== null && pctMatches(bucket.covered, bucket.total, bucket.pct);
  },
  (bucket) =>
    `coverage bucket covered=${bucket.covered} total=${bucket.total} pct=${bucket.pct} is inconsistent; expected covered <= total, pct null when total is 0, otherwise pct = covered/total*100`
);

export const CoverageSummarySchema = Type.Object(
  {
    lines: CoverageBucketSchema,
    functions: CoverageBucketSchema,
    statements: Type.Union([CoverageBucketSchema, Type.Null()]),
    branches: Type.Union([CoverageBucketSchema, Type.Null()]),
  },
  { additionalProperties: false }
);

/** Line counts for one class of files. `total` must equal code + comment + blank. */
const LocBucketSchema = Type.Refine(
  Type.Object(
    { files: count, code: count, comment: count, blank: count, total: count },
    { additionalProperties: false }
  ),
  (bucket) =>
    bucket.total === bucket.code + bucket.comment + bucket.blank &&
    (bucket.files > 0 || bucket.total === 0),
  (bucket) =>
    `LoC bucket files=${bucket.files} code=${bucket.code} comment=${bucket.comment} blank=${bucket.blank} total=${bucket.total} is inconsistent; expected total = code + comment + blank and no lines without files`
);

/** File classes a tracked file is counted under. */
export const LOC_CLASSES = [
  'production',
  'test',
  'generated',
  'fixture',
  'config',
  'docs',
] as const;
export type LocClass = (typeof LOC_CLASSES)[number];

const LocStatsSchema = Type.Object(
  {
    production: LocBucketSchema,
    test: LocBucketSchema,
    generated: LocBucketSchema,
    fixture: LocBucketSchema,
    config: LocBucketSchema,
    docs: LocBucketSchema,
  },
  { additionalProperties: false }
);

const DuplicationStatsSchema = Type.Object(
  {
    clones: count,
    duplicatedLines: count,
    percentage: Type.Number({ minimum: 0, maximum: 100 }),
  },
  { additionalProperties: false }
);

const BundleStatsSchema = Type.Object(
  {
    files: count,
    rawBytes: count,
    gzipBytes: count,
    jsGzipBytes: count,
    cssGzipBytes: count,
    htmlGzipBytes: count,
  },
  { additionalProperties: false }
);

const DependencyStatsSchema = Type.Object(
  {
    workspaceManifests: count,
    directDependencies: count,
    directDevDependencies: count,
    lockedPackages: count,
  },
  { additionalProperties: false }
);

const TestErrorHeadlineSchema = Type.Object(
  {
    message: Type.String({ maxLength: 400 }),
    originatedIn: Type.Union([Type.String({ maxLength: 400 }), Type.Null()]),
  },
  { additionalProperties: false }
);

export const TestSuiteStatsSchema = Type.Object(
  {
    exitCode: Type.Union([Type.Integer(), Type.Null()]),
    durationSeconds: Type.Union([boundedNumber, Type.Null()]),
    passed: count,
    root: count,
    frontend: count,
    api: count,
    shared: count,
    failed: Type.Optional(count),
    failedFiles: Type.Optional(count),
    errors: Type.Optional(count),
    headlines: Type.Optional(Type.Array(TestErrorHeadlineSchema, { maxItems: 8 })),
    parseMiss: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);

const ToolingCheckStatsSchema = Type.Object(
  {
    checkExitCode: Type.Integer(),
    failedTasks: Type.Array(Type.String({ maxLength: 200 }), { maxItems: 64 }),
  },
  { additionalProperties: false }
);

const NAME_CHARS = '[A-Za-z0-9_.@/-]{1,120}';
const NAME_PATTERN = `^${NAME_CHARS}$`;
const ROOT_PATTERN = '^[A-Za-z0-9_.@-]+(/[A-Za-z0-9_.@-]+)*$';

/**
 * One discovered unit of the repository with its per-component measurements.
 * `id` is `<kind>:<name>` so a component that moves directories keeps its
 * identity; `root` is the repository-relative directory that owns its files.
 *
 * Later PRs extend this object (per-lane test results, per-file function
 * coverage, per-crate Rust coverage) with more measurement fields.
 */
const ComponentSchema = Type.Refine(
  Type.Object(
    {
      id: Type.String({
        pattern: `^(workspace|crate|scripts):${NAME_CHARS}$`,
        maxLength: 140,
      }),
      kind: Type.Union([Type.Literal('workspace'), Type.Literal('crate'), Type.Literal('scripts')]),
      name: Type.String({ pattern: NAME_PATTERN }),
      root: Type.String({ pattern: ROOT_PATTERN, maxLength: 200 }),
      loc: measurement(LocStatsSchema),
      coverage: measurement(CoverageSummarySchema),
      tsErrors: measurement(count),
    },
    { additionalProperties: false }
  ),
  (component) =>
    component.id === `${component.kind}:${component.name}` &&
    !component.root.split('/').includes('..'),
  (component) =>
    `component id ${component.id} root ${component.root} is inconsistent; expected id "<kind>:<name>" (${component.kind}:${component.name}) and a root without ".." segments`
);

const hasUniqueValues = (values: readonly string[]): boolean =>
  new Set(values).size === values.length;

export const MetricsSchema = Type.Object(
  {
    sha: Type.String({ pattern: '^[0-9a-f]{40}$' }),
    generatedAt: Type.String({ maxLength: 64 }),
    components: Type.Refine(
      Type.Array(ComponentSchema, { minItems: 1, maxItems: 200 }),
      (components) =>
        hasUniqueValues(components.map((component) => component.id)) &&
        hasUniqueValues(components.map((component) => component.root)),
      (components) =>
        `components [${components.map((component) => component.id).join(', ')}] repeat an id or a root; expected each discovered component once`
    ),
    duplication: measurement(DuplicationStatsSchema),
    circularDeps: measurement(count),
    frontendBundle: measurement(BundleStatsSchema),
    dependencies: measurement(DependencyStatsSchema),
    tests: measurement(TestSuiteStatsSchema),
    tooling: measurement(ToolingCheckStatsSchema),
  },
  { additionalProperties: false }
);

export type CoverageSummary = Static<typeof CoverageSummarySchema>;
export type LocBucket = Static<typeof LocBucketSchema>;
export type LocStats = Static<typeof LocStatsSchema>;
export type DuplicationStats = Static<typeof DuplicationStatsSchema>;
export type BundleStats = Static<typeof BundleStatsSchema>;
export type DependencyStats = Static<typeof DependencyStatsSchema>;
export type TestErrorHeadline = Static<typeof TestErrorHeadlineSchema>;
export type TestSuiteStats = Static<typeof TestSuiteStatsSchema>;
export type ToolingCheckStats = Static<typeof ToolingCheckStatsSchema>;
export type Component = Static<typeof ComponentSchema>;
export type ComponentKind = Component['kind'];
export type Metrics = Static<typeof MetricsSchema>;
