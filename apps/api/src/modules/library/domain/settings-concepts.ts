import type {
  ConceptComparison,
  ConceptComparisonEntry,
  LibraryTargetId,
  SettingsConcept,
  SettingsField,
  SettingsSnapshot,
} from '@mangostudio/shared/library';

type ComparedTargetId = Exclude<LibraryTargetId, 'mangostudio'>;

type FieldSelector =
  | { readonly kind: 'exact'; readonly paths: readonly string[] }
  | { readonly kind: 'prefix'; readonly path: string }
  | { readonly kind: 'rules-decision'; readonly decision: 'allow' | 'deny' };

interface ConceptDefinition {
  readonly concept: SettingsConcept;
  readonly selectors: Readonly<Partial<Record<ComparedTargetId, FieldSelector>>>;
}

const COMPARISON_TARGETS: readonly ComparedTargetId[] = ['claude', 'codex', 'cursor'];

/**
 * Presentational navigation only. These paths point at settings with roughly
 * similar intent; they do not define equivalent values and must never drive a
 * copy, merge, or write between vendors.
 */
const CONCEPT_DEFINITIONS: readonly ConceptDefinition[] = [
  {
    concept: 'default-permission-mode',
    selectors: {
      claude: { kind: 'exact', paths: ['permissions.defaultMode'] },
      codex: { kind: 'exact', paths: ['default_permissions'] },
      cursor: { kind: 'exact', paths: ['sandbox.mode', 'approvalMode'] },
    },
  },
  {
    concept: 'allow-list',
    selectors: {
      claude: { kind: 'prefix', path: 'permissions.allow[' },
      codex: { kind: 'rules-decision', decision: 'allow' },
      cursor: { kind: 'prefix', path: 'permissions.allow[' },
    },
  },
  {
    concept: 'deny-list',
    selectors: {
      claude: { kind: 'prefix', path: 'permissions.deny[' },
      codex: { kind: 'rules-decision', decision: 'deny' },
      cursor: { kind: 'prefix', path: 'permissions.deny[' },
    },
  },
  {
    concept: 'selected-model',
    selectors: {
      claude: { kind: 'exact', paths: ['model'] },
      codex: { kind: 'exact', paths: ['model'] },
      cursor: { kind: 'exact', paths: ['selectedModel.modelId'] },
    },
  },
  {
    concept: 'reasoning-effort',
    selectors: {
      claude: { kind: 'exact', paths: ['effortLevel'] },
      codex: { kind: 'exact', paths: ['model_reasoning_effort'] },
    },
  },
];

export function compareSettingsSnapshots(
  snapshots: readonly SettingsSnapshot[]
): ConceptComparison[] {
  const byTarget = new Map(snapshots.map((snapshot) => [snapshot.targetId, snapshot]));
  return CONCEPT_DEFINITIONS.map((definition) => ({
    concept: definition.concept,
    comparability: 'rough',
    entries: COMPARISON_TARGETS.map((targetId) =>
      compareTarget(targetId, definition.selectors[targetId], byTarget.get(targetId))
    ),
  }));
}

function compareTarget(
  targetId: ComparedTargetId,
  selector: FieldSelector | undefined,
  snapshot: SettingsSnapshot | undefined
): ConceptComparisonEntry {
  if (!selector) return { targetId, state: 'not-applicable', fields: [] };
  const fields = snapshot ? selectFields(snapshot, selector) : [];
  return {
    targetId,
    state: fields.length > 0 ? 'detected' : 'not-detected',
    fields,
  };
}

function selectFields(snapshot: SettingsSnapshot, selector: FieldSelector): SettingsField[] {
  const fields = snapshot.sources.flatMap((source) => source.fields);
  if (selector.kind === 'exact') {
    const paths = new Set(selector.paths);
    return fields.filter((field) => paths.has(field.path));
  }
  if (selector.kind === 'prefix') {
    return fields.filter((field) => field.path.startsWith(selector.path));
  }
  return selectRulePatterns(fields, selector.decision);
}

function selectRulePatterns(
  fields: readonly SettingsField[],
  decision: 'allow' | 'deny'
): SettingsField[] {
  const patternsByPath = new Map(
    fields
      .filter((field) => field.path.endsWith('.pattern'))
      .map((field) => [field.path.slice(0, -'.pattern'.length), field])
  );

  return fields.flatMap((field) => {
    if (
      !field.path.endsWith('.decision') ||
      field.presentation !== 'value' ||
      field.value !== decision
    ) {
      return [];
    }
    const basePath = field.path.slice(0, -'.decision'.length);
    const pattern = patternsByPath.get(basePath);
    return pattern ? [pattern] : [];
  });
}
