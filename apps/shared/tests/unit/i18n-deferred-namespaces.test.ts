/**
 * The English dictionary is shipped in pieces: an eager part that rides in the
 * frontend's entry chunk, the deferred namespaces (`settings`, `onboarding`)
 * that load with the routes reading them, and the feature namespaces
 * (`environments`, `git`, `github`, `library`) split by key between the eager part
 * and a file the feature's lazy chunk imports. These tests pin the split: nothing
 * deferred in the eager part, each file owns exactly its namespace, and the
 * barrel's complete `en` is the union with no key lost or doubled.
 */

import { describe, expect, it } from 'bun:test';

import { en, ptBR } from '../../src/i18n';
import { messages as core } from '../../src/i18n/en';
import { messages as environments } from '../../src/i18n/en-environments';
import { messages as git } from '../../src/i18n/en-git';
import { messages as github } from '../../src/i18n/en-github';
import { messages as library } from '../../src/i18n/en-library';
import { messages as onboarding } from '../../src/i18n/en-onboarding';
import { messages as settings } from '../../src/i18n/en-settings';
import type { DeferredNamespace, FeatureNamespace } from '../../src/i18n/types';

const DEFERRED: readonly DeferredNamespace[] = ['settings', 'onboarding'];

/** The namespaces split in two: some keys eager, the rest in `en-<name>.ts` for the feature's chunk. */
const FEATURE_NAMESPACES: readonly FeatureNamespace[] = [
  'environments',
  'git',
  'github',
  'library',
];
const featureFiles = { environments, git, github, library };

describe('English dictionary pieces', () => {
  it('keeps every deferred namespace out of the eager dictionary', () => {
    const leaked = DEFERRED.filter((namespace) => namespace in core);

    expect(
      leaked,
      `expected the eager dictionary to hold no deferred namespace | received: ${leaked.join(', ')}`
    ).toEqual([]);
  });

  it('gives each deferred file exactly its own namespace', () => {
    expect(Object.keys(settings)).toEqual(['settings']);
    expect(Object.keys(onboarding)).toEqual(['onboarding']);
  });

  it('assembles the complete dictionary from the pieces with the same top-level keys as pt-BR', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ptBR).sort());
    expect(en.settings).toBe(settings.settings);
    expect(en.onboarding).toBe(onboarding.onboarding);
    expect(en.auth).toBe(core.auth);
  });

  describe.each(FEATURE_NAMESPACES)('the split %s namespace', (namespace) => {
    const file: Record<string, object> = featureFiles[namespace];
    const eagerKeys = Object.keys(core[namespace]);
    const featureKeys = Object.keys(file[namespace] ?? {});

    it('gives its feature file exactly its own namespace', () => {
      expect(Object.keys(file)).toEqual([namespace]);
    });

    it('holds each key in exactly one of the two English files', () => {
      const doubled = eagerKeys.filter((key) => featureKeys.includes(key));

      expect(
        doubled,
        `expected no ${namespace} key in both en.ts and en-${namespace}.ts | received: ${doubled.join(', ')}`
      ).toEqual([]);
    });

    it('loses no key of the pt-BR source of truth', () => {
      expect([...eagerKeys, ...featureKeys].sort()).toEqual(Object.keys(ptBR[namespace]).sort());
      expect(
        featureKeys.length,
        `expected en-${namespace}.ts to hold keys (an empty file defers nothing) | received: none`
      ).toBeGreaterThan(0);
    });

    it('is joined back, key for key, in the complete dictionary', () => {
      const joined: object = { ...core[namespace], ...file[namespace] };

      const complete: object = en[namespace];

      expect(complete).toEqual(joined);
    });
  });

  it('keeps the strings the first paint reads in the eager dictionary', () => {
    // The sidebar, the account menu and the autosave failure toast render outside
    // any settings route, so their strings must not need the settings namespace.
    expect(core.common.settings).toBe('Settings');
    expect(core.errors.settingsSaveFailed).toBeTruthy();
    expect(core.errors.settingsSaveReverted).toBeTruthy();
  });
});
