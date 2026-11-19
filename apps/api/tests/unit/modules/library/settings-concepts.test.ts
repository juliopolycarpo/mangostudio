import { describe, expect, it } from 'bun:test';

import type { LibraryTargetId, SettingsField, SettingsSnapshot } from '@mangostudio/shared/library';

import { compareSettingsSnapshots } from '../../../../src/modules/library/domain/settings-concepts';
import { parsePermissionRules } from '../../../../src/modules/library/infrastructure/settings-parsers/rules';

function snapshot(targetId: LibraryTargetId, fields: SettingsField[]): SettingsSnapshot {
  return {
    targetId,
    sources: [
      {
        locationId: `${targetId}-settings`,
        kind: 'setting',
        present: true,
        parsed: true,
        sizeBytes: 1,
        fields,
      },
    ],
  };
}

function fieldValue(field: SettingsField): string | undefined {
  return field.presentation === 'value' ? field.value : undefined;
}

describe('settings concepts', () => {
  it('marks a concept without a target mapping as not applicable', () => {
    const comparisons = compareSettingsSnapshots([
      snapshot('claude', [
        {
          path: 'effortLevel',
          presentation: 'value',
          value: 'high',
        },
      ]),
      snapshot('codex', [
        {
          path: 'model_reasoning_effort',
          presentation: 'value',
          value: 'high',
        },
      ]),
      snapshot('cursor', []),
    ]);

    expect(comparisons.find(({ concept }) => concept === 'reasoning-effort')).toEqual({
      concept: 'reasoning-effort',
      comparability: 'rough',
      entries: [
        {
          targetId: 'claude',
          state: 'detected',
          fields: [
            {
              path: 'effortLevel',
              presentation: 'value',
              value: 'high',
            },
          ],
        },
        {
          targetId: 'codex',
          state: 'detected',
          fields: [
            {
              path: 'model_reasoning_effort',
              presentation: 'value',
              value: 'high',
            },
          ],
        },
        {
          targetId: 'cursor',
          state: 'not-applicable',
          fields: [],
        },
      ],
    });
  });

  it('marks an applicable but missing setting as not detected', () => {
    const comparisons = compareSettingsSnapshots([
      snapshot('claude', [{ path: 'model', presentation: 'value', value: 'sonnet' }]),
      snapshot('codex', [{ path: 'model', presentation: 'value', value: 'gpt-5' }]),
      snapshot('cursor', []),
    ]);

    expect(
      comparisons
        .find(({ concept }) => concept === 'selected-model')
        ?.entries.find(({ targetId }) => targetId === 'cursor')
    ).toEqual({
      targetId: 'cursor',
      state: 'not-detected',
      fields: [],
    });
  });

  it('maps Codex rule patterns into their allow and deny concepts', () => {
    const comparisons = compareSettingsSnapshots([
      snapshot('codex', [
        {
          path: 'default.rules[1].pattern',
          presentation: 'value',
          value: '["git", "status"]',
        },
        {
          path: 'default.rules[1].decision',
          presentation: 'value',
          value: 'allow',
        },
        {
          path: 'default.rules[2].pattern',
          presentation: 'value',
          value: '["rm"]',
        },
        {
          path: 'default.rules[2].decision',
          presentation: 'value',
          value: 'forbidden',
        },
      ]),
    ]);

    expect(
      comparisons
        .find(({ concept }) => concept === 'allow-list')
        ?.entries.find(({ targetId }) => targetId === 'codex')
    ).toEqual({
      targetId: 'codex',
      state: 'detected',
      fields: [
        {
          path: 'default.rules[1].pattern',
          presentation: 'value',
          value: '["git", "status"]',
        },
      ],
    });
  });

  it('reads a real Codex .rules file: forbidden is the deny list, prompt is neither list', () => {
    // The file is parsed rather than hand-built so the decision value reaching
    // the concept is the one the parser extracts from Codex's own spelling.
    const parsed = parsePermissionRules(
      [
        {
          name: 'default.rules',
          content: [
            '# Codex rules: decisions are allow | prompt | forbidden',
            'prefix_rule(pattern = ["git", "status"], decision = "allow")',
            'prefix_rule(pattern = ["git", "push"], decision = "prompt")',
            'prefix_rule(pattern = ["rm", "-rf"], decision = "forbidden")',
          ].join('\n'),
        },
      ],
      { homeDir: '/home/ada' }
    );
    const comparisons = compareSettingsSnapshots([snapshot('codex', [...parsed.fields])]);
    const codexEntry = (concept: string) =>
      comparisons
        .find((comparison) => comparison.concept === concept)
        ?.entries.find(({ targetId }) => targetId === 'codex');

    expect({
      deny: codexEntry('deny-list')?.fields.map(fieldValue),
      allow: codexEntry('allow-list')?.fields.map(fieldValue),
    }).toEqual({
      deny: ['["rm", "-rf"]'],
      allow: ['["git", "status"]'],
    });
    expect(codexEntry('deny-list')?.state).toBe('detected');
  });

  it('reports not-detected when Codex rules hold no forbidden decision', () => {
    const comparisons = compareSettingsSnapshots([
      snapshot('codex', [
        { path: 'default.rules[1].pattern', presentation: 'value', value: '["git"]' },
        { path: 'default.rules[1].decision', presentation: 'value', value: 'prompt' },
      ]),
    ]);

    const entries = comparisons.flatMap((comparison) =>
      comparison.entries
        .filter(({ targetId }) => targetId === 'codex')
        .map(({ state }) => [comparison.concept, state])
    );
    expect(Object.fromEntries(entries)).toMatchObject({
      'allow-list': 'not-detected',
      'deny-list': 'not-detected',
    });
  });

  it('keeps the complete concept table aligned with vendor field paths', () => {
    const comparisons = compareSettingsSnapshots([
      snapshot('claude', [
        { path: 'permissions.defaultMode', presentation: 'value', value: 'default' },
        { path: 'permissions.allow[0]', presentation: 'value', value: 'Read' },
        { path: 'permissions.deny[0]', presentation: 'value', value: 'Write' },
        { path: 'model', presentation: 'value', value: 'sonnet' },
        { path: 'effortLevel', presentation: 'value', value: 'high' },
      ]),
      snapshot('codex', [
        { path: 'default_permissions', presentation: 'value', value: 'workspace-write' },
        { path: 'default.rules[1].pattern', presentation: 'value', value: '["git"]' },
        { path: 'default.rules[1].decision', presentation: 'value', value: 'allow' },
        { path: 'default.rules[2].pattern', presentation: 'value', value: '["rm"]' },
        { path: 'default.rules[2].decision', presentation: 'value', value: 'forbidden' },
        { path: 'model', presentation: 'value', value: 'gpt-5' },
        { path: 'model_reasoning_effort', presentation: 'value', value: 'high' },
      ]),
      snapshot('cursor', [
        { path: 'sandbox.mode', presentation: 'value', value: 'workspace' },
        { path: 'approvalMode', presentation: 'value', value: 'ask' },
        { path: 'permissions.allow[0]', presentation: 'value', value: 'Read' },
        { path: 'permissions.deny[0]', presentation: 'value', value: 'Write' },
        { path: 'selectedModel.modelId', presentation: 'value', value: 'cursor-large' },
      ]),
    ]);

    expect(
      Object.fromEntries(
        comparisons.map((comparison) => [
          comparison.concept,
          Object.fromEntries(
            comparison.entries.map((entry) => [
              entry.targetId,
              {
                state: entry.state,
                paths: entry.fields.map((field) => field.path),
              },
            ])
          ),
        ])
      )
    ).toEqual({
      'default-permission-mode': {
        claude: { state: 'detected', paths: ['permissions.defaultMode'] },
        codex: { state: 'detected', paths: ['default_permissions'] },
        cursor: { state: 'detected', paths: ['sandbox.mode', 'approvalMode'] },
      },
      'allow-list': {
        claude: { state: 'detected', paths: ['permissions.allow[0]'] },
        codex: { state: 'detected', paths: ['default.rules[1].pattern'] },
        cursor: { state: 'detected', paths: ['permissions.allow[0]'] },
      },
      'deny-list': {
        claude: { state: 'detected', paths: ['permissions.deny[0]'] },
        codex: { state: 'detected', paths: ['default.rules[2].pattern'] },
        cursor: { state: 'detected', paths: ['permissions.deny[0]'] },
      },
      'selected-model': {
        claude: { state: 'detected', paths: ['model'] },
        codex: { state: 'detected', paths: ['model'] },
        cursor: { state: 'detected', paths: ['selectedModel.modelId'] },
      },
      'reasoning-effort': {
        claude: { state: 'detected', paths: ['effortLevel'] },
        codex: { state: 'detected', paths: ['model_reasoning_effort'] },
        cursor: { state: 'not-applicable', paths: [] },
      },
    });
  });
});
