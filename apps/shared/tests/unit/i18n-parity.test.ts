import { describe, expect, it } from 'bun:test';

import { LtsStatusSchema, RuntimeFindingCodeSchema } from '../../src/environments';
import { en, ptBR } from '../../src/i18n';
import {
  AdaptNoteSchema,
  LibraryCoverageStateSchema,
  LibraryDivergenceSchema,
  PropagationBlockedReasonSchema,
  type PropagationOperation,
  PropagationOperationSchema,
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
    path: 'library.blockedReason',
    values: literalValues(PropagationBlockedReasonSchema),
    blocks: [en.library.blockedReason, ptBR.library.blockedReason],
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

function hasUnbalancedBraces(value: string) {
  let depth = 0;

  for (const character of value) {
    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
    }

    if (depth < 0) {
      return true;
    }
  }

  return depth !== 0;
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

  it('rejects unbalanced placeholder braces', () => {
    const errors = flattenedLocales.flatMap(({ name, messages }) =>
      [...messages]
        .filter(([, value]) => hasUnbalancedBraces(value))
        .map(([key]) => `${key}: ${name} has unbalanced braces`)
    );

    expect(errors).toEqual([]);
  });

  it('rejects empty translation values', () => {
    const errors = flattenedLocales.flatMap(({ name, messages }) =>
      [...messages]
        .filter(([, value]) => value.length === 0)
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
