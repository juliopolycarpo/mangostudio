import { describe, expect, it } from 'bun:test';

import { ApiKeyScopeSchema } from '../../src/api-keys';
import { CapabilityReasonCodeSchema } from '../../src/capabilities';
import {
  ContainerFailureReasonSchema,
  InstallGuardReasonSchema,
  LtsStatusSchema,
  RuntimeFindingCodeSchema,
  SshFailureReasonSchema,
} from '../../src/environments';
import {
  ExternalAgentRemedyKindSchema,
  ExternalAgentUnavailableReasonSchema,
  ExternalApprovalRoutingSchema,
  ExternalPermissionLevelSchema,
  ExternalPermissionPresetIdSchema,
  ExternalTurnTerminalReasonSchema,
} from '../../src/external-agents';
import {
  GithubCheckBucketSchema,
  GithubIssueFilterSchema,
  GithubIssueStateSchema,
  GithubMergeableStateSchema,
  GithubMergeStateStatusSchema,
  GithubPrFilterSchema,
  GithubReviewDecisionSchema,
} from '../../src/github';
import { en, ptBR } from '../../src/i18n';
import {
  AdaptNoteSchema,
  BackupSetOperationSchema,
  LibraryCoverageStateSchema,
  LibraryDivergenceSchema,
  LibraryTargetIdSchema,
  PropagationBlockedReasonSchema,
  type PropagationOperation,
  PropagationOperationSchema,
  RemovalBlockedReasonSchema,
  RemovalFailureReasonSchema,
} from '../../src/library';

type FlatDictionary = Map<string, string>;
type LiteralUnionSchema = {
  anyOf: readonly { const: string }[];
};

const LOCALES = [
  { name: 'en', messages: en },
  { name: 'pt-BR', messages: ptBR },
] as const;

const PROPAGATION_OPERATION_MESSAGES = {
  create: 'library.review.groupCreate',
  overwrite: 'library.review.groupOverwrite',
  noop: 'library.review.groupNoop',
  'adapt-create': 'library.review.groupAdapt',
  'adapt-overwrite': 'library.review.groupAdapt',
  blocked: 'library.review.groupBlocked',
} as const satisfies Readonly<Record<PropagationOperation, string>>;

const ENUM_COVERAGE = [
  {
    path: 'chat.capabilities.reasons',
    values: literalValues(CapabilityReasonCodeSchema),
    blocks: [en.chat.capabilities.reasons, ptBR.chat.capabilities.reasons],
  },
  {
    path: 'environments.findings',
    values: literalValues(RuntimeFindingCodeSchema),
    blocks: [en.environments.findings, ptBR.environments.findings],
  },
  {
    path: 'environments.lts',
    values: literalValues(LtsStatusSchema),
    blocks: [en.environments.lts, ptBR.environments.lts],
  },
  {
    path: 'environments.entities.ssh.reason',
    values: literalValues(SshFailureReasonSchema),
    blocks: [en.environments.entities.ssh.reason, ptBR.environments.entities.ssh.reason],
  },
  {
    path: 'environments.entities.container.reason',
    values: literalValues(ContainerFailureReasonSchema),
    blocks: [
      en.environments.entities.container.reason,
      ptBR.environments.entities.container.reason,
    ],
  },
  {
    path: 'environments.install.guardBlocked',
    values: literalValues(InstallGuardReasonSchema),
    blocks: [en.environments.install.guardBlocked, ptBR.environments.install.guardBlocked],
  },
  {
    path: 'library.coverage',
    values: literalValues(LibraryCoverageStateSchema),
    blocks: [en.library.coverage, ptBR.library.coverage],
  },
  {
    path: 'library.divergence',
    values: literalValues(LibraryDivergenceSchema),
    blocks: [en.library.divergence, ptBR.library.divergence],
  },
  {
    path: 'library.adaptation.note',
    values: literalValues(AdaptNoteSchema.properties.code),
    blocks: [en.library.adaptation.note, ptBR.library.adaptation.note],
  },
  {
    // One catalog, two enums: propagation and removal block for mostly the same
    // reasons, and a reader sees the same sentence whichever flow refused.
    path: 'library.blockedReason',
    values: [
      ...new Set([
        ...literalValues(PropagationBlockedReasonSchema),
        ...literalValues(RemovalBlockedReasonSchema),
      ]),
    ],
    blocks: [en.library.blockedReason, ptBR.library.blockedReason],
  },
  {
    path: 'library.removalFailureReason',
    values: literalValues(RemovalFailureReasonSchema),
    blocks: [en.library.removalFailureReason, ptBR.library.removalFailureReason],
  },
  {
    // An origin with no label is a backup row that cannot say what undoing it
    // would do, which is the one mistake in this feature that deletes files.
    path: 'library.backups.origin',
    values: literalValues(BackupSetOperationSchema),
    blocks: [en.library.backups.origin, ptBR.library.backups.origin],
  },
  {
    // The one place a target is given a name. The external-agent selector
    // reuses these rather than declaring a second label for the same tool.
    path: 'library.targets',
    values: literalValues(LibraryTargetIdSchema),
    blocks: [en.library.targets, ptBR.library.targets],
  },
  {
    // A target the selector cannot offer has to be able to say why; a missing
    // sentence here is a greyed row with no explanation.
    path: 'externalAgents.unavailable',
    values: literalValues(ExternalAgentUnavailableReasonSchema),
    blocks: [en.externalAgents.unavailable, ptBR.externalAgents.unavailable],
  },
  {
    // How a turn ended is the sentence a reader gets instead of the transcript
    // they expected. A member with no copy renders as nothing at all, and this
    // union had no coverage entry until `interrupted` was added to it.
    path: 'externalAgents.turn.terminal',
    values: literalValues(ExternalTurnTerminalReasonSchema),
    blocks: [en.externalAgents.turn.terminal, ptBR.externalAgents.turn.terminal],
  },
  {
    // A remedy with no copy is a button with no label on the one row that has
    // something actionable to say.
    path: 'externalAgents.remedy',
    values: literalValues(ExternalAgentRemedyKindSchema),
    blocks: [en.externalAgents.remedy, ptBR.externalAgents.remedy],
  },
  {
    path: 'externalAgents.permission.level',
    values: literalValues(ExternalPermissionLevelSchema),
    blocks: [en.externalAgents.permission.level, ptBR.externalAgents.permission.level],
  },
  {
    path: 'externalAgents.permission.routing',
    values: literalValues(ExternalApprovalRoutingSchema),
    blocks: [en.externalAgents.permission.routing, ptBR.externalAgents.permission.routing],
  },
  {
    // A preset with no copy is an unlabelled row in the one control a
    // non-expert is meant to use, so both blocks are pinned to the union.
    path: 'externalAgents.permission.preset',
    values: literalValues(ExternalPermissionPresetIdSchema),
    blocks: [en.externalAgents.permission.preset, ptBR.externalAgents.permission.preset],
  },
  {
    // The per-vendor one-liner, which is the whole reason a preset can be
    // honest: `careful` is a sandbox for Codex and plan mode for Claude.
    path: 'externalAgents.permission.presetVendor',
    values: literalValues(ExternalPermissionPresetIdSchema),
    blocks: [
      en.externalAgents.permission.presetVendor,
      ptBR.externalAgents.permission.presetVendor,
    ],
  },
  {
    // The GitHub panel renders every one of gh's vocabularies as a chip or a
    // filter tab. A member with no sentence is a blank badge on a row that
    // otherwise looks fine, so each union is pinned to its block here.
    path: 'github.issueState',
    values: literalValues(GithubIssueStateSchema),
    blocks: [en.github.issueState, ptBR.github.issueState],
  },
  {
    // "No decision" is `github.reviewDecisionNone`, deliberately outside this
    // block: it is a null on the wire, not a fourth member.
    path: 'github.reviewDecision',
    values: literalValues(GithubReviewDecisionSchema),
    blocks: [en.github.reviewDecision, ptBR.github.reviewDecision],
  },
  {
    path: 'github.checkBucket',
    values: literalValues(GithubCheckBucketSchema),
    blocks: [en.github.checkBucket, ptBR.github.checkBucket],
  },
  {
    path: 'github.mergeState',
    values: literalValues(GithubMergeStateStatusSchema),
    blocks: [en.github.mergeState, ptBR.github.mergeState],
  },
  {
    path: 'github.mergeable',
    values: literalValues(GithubMergeableStateSchema),
    blocks: [en.github.mergeable, ptBR.github.mergeable],
  },
  {
    // Filter tabs. A missing label here is worse than a blank badge: the tab
    // that would run `--author=@me` is unlabelled and therefore unreachable.
    path: 'github.prFilter',
    values: literalValues(GithubPrFilterSchema),
    blocks: [en.github.prFilter, ptBR.github.prFilter],
  },
  {
    path: 'github.issueFilter',
    values: literalValues(GithubIssueFilterSchema),
    blocks: [en.github.issueFilter, ptBR.github.issueFilter],
  },
  {
    path: 'settings.externalApi.scope',
    values: literalValues(ApiKeyScopeSchema),
    blocks: [en.settings.externalApi.scope, ptBR.settings.externalApi.scope],
  },
  {
    path: 'settings.externalApi.scopeHint',
    values: literalValues(ApiKeyScopeSchema),
    blocks: [en.settings.externalApi.scopeHint, ptBR.settings.externalApi.scopeHint],
  },
] as const;

function flatten(dictionary: object, prefix = '', result: FlatDictionary = new Map()) {
  for (const [key, value] of Object.entries(dictionary)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (typeof value === 'string') {
      result.set(path, value);
      continue;
    }

    flatten(value, path, result);
  }

  return result;
}

function tokensOf(value: string) {
  return new Set(Array.from(value.matchAll(/\{(\w+)\}/g), (match) => match[1]));
}

function formatTokens(tokens: Set<string>) {
  return `{${[...tokens].sort().join(',')}}`;
}

function hasInvalidPlaceholderSyntax(value: string) {
  let index = 0;

  while (index < value.length) {
    if (value[index] === '}') {
      return true;
    }

    if (value[index] !== '{') {
      index += 1;
      continue;
    }

    const end = value.indexOf('}', index + 1);
    if (end === -1 || !/^\w+$/.test(value.slice(index + 1, end))) {
      return true;
    }

    index = end + 1;
  }

  return false;
}

function literalValues(schema: LiteralUnionSchema) {
  return schema.anyOf.map((member) => member.const);
}

function compareValues(expected: readonly string[], actual: readonly string[]) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);

  return {
    missing: expected.filter((value) => !actualSet.has(value)),
    extra: actual.filter((value) => !expectedSet.has(value)),
  };
}

const flattenedLocales = LOCALES.map(({ name, messages }) => ({
  name,
  messages: flatten(messages),
}));

describe('i18n structural parity', () => {
  it('keeps locale key sets identical', () => {
    const [english, portuguese] = flattenedLocales;
    const englishKeys = [...english.messages.keys()].sort();
    const portugueseKeys = [...portuguese.messages.keys()].sort();
    const { missing: missingFromPortuguese, extra: missingFromEnglish } = compareValues(
      englishKeys,
      portugueseKeys
    );

    expect([
      ...missingFromPortuguese.map((key) => `${key}: missing from pt-BR`),
      ...missingFromEnglish.map((key) => `${key}: missing from en`),
    ]).toEqual([]);
  });

  it('keeps placeholder token sets identical per key', () => {
    const [english, portuguese] = flattenedLocales;
    const mismatches: string[] = [];

    for (const [key, englishValue] of english.messages) {
      const portugueseValue = portuguese.messages.get(key);
      if (portugueseValue === undefined) {
        continue;
      }

      const englishTokens = tokensOf(englishValue);
      const portugueseTokens = tokensOf(portugueseValue);
      if (formatTokens(englishTokens) !== formatTokens(portugueseTokens)) {
        mismatches.push(
          `${key}: en has ${formatTokens(englishTokens)}, pt-BR has ${formatTokens(portugueseTokens)}`
        );
      }
    }

    expect(mismatches).toEqual([]);
  });

  it('rejects invalid placeholder syntax', () => {
    const errors = flattenedLocales.flatMap(({ name, messages }) =>
      [...messages]
        .filter(([, value]) => hasInvalidPlaceholderSyntax(value))
        .map(([key]) => `${key}: ${name} has invalid placeholder syntax`)
    );

    expect(errors).toEqual([]);
  });

  it('rejects empty translation values', () => {
    const errors = flattenedLocales.flatMap(({ name, messages }) =>
      [...messages]
        .filter(([, value]) => value.trim().length === 0)
        .map(([key]) => `${key}: ${name} is empty`)
    );

    expect(errors).toEqual([]);
  });

  it('rejects placeholder syntax from other interpolation systems', () => {
    const leakedPlaceholder = /%[cdifjoOs]|\{\{\s*\w+\s*\}\}|\$\d+/g;
    const errors = flattenedLocales.flatMap(({ name, messages }) =>
      [...messages].flatMap(([key, value]) => {
        const matches = value.match(leakedPlaceholder);
        return matches ? [`${key}: ${name} leaks ${matches.join(', ')}`] : [];
      })
    );

    expect(errors).toEqual([]);
  });
});

describe('i18n enum coverage', () => {
  for (const { path, values, blocks } of ENUM_COVERAGE) {
    it(`covers every ${path} value in every locale`, () => {
      const errors = blocks.flatMap((block, index) => {
        const locale = LOCALES[index];
        const { missing, extra } = compareValues(values, Object.keys(block));

        return [
          ...missing.map((value) => `${path}.${value}: missing from ${locale.name}`),
          ...extra.map((value) => `${path}.${value}: has no matching domain value`),
        ];
      });

      expect(errors).toEqual([]);
    });
  }

  it('maps every propagation operation to a translated review group', () => {
    const operationValues = literalValues(PropagationOperationSchema);
    const { missing, extra } = compareValues(
      operationValues,
      Object.keys(PROPAGATION_OPERATION_MESSAGES)
    );
    const errors = [
      ...missing.map((value) => `library propagation operation ${value}: missing message mapping`),
      ...extra.map((value) => `library propagation operation ${value}: unknown message mapping`),
    ];

    for (const { name, messages } of flattenedLocales) {
      for (const [operation, path] of Object.entries(PROPAGATION_OPERATION_MESSAGES)) {
        if (!messages.has(path)) {
          errors.push(`${operation}: ${name} is missing ${path}`);
        }
      }
    }

    expect(errors).toEqual([]);
  });
});
