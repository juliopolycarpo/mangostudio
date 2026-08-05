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
import { en, ptBR } from '../../src/i18n';
import {
  AdaptNoteSchema,
  BackupSetOperationSchema,
  LibraryCoverageStateSchema,
  LibraryDivergenceSchema,
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
