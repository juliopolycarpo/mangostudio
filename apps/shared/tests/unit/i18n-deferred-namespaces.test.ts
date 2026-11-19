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

/** Every message of a tree as a dotted path (`entities.status.connected`). */
function messagePaths(tree: object, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'object' && value !== null
      ? messagePaths(value, `${prefix}${key}.`)
      : [`${prefix}${key}`]
  );
}

/** `base` with `added` laid over it, joining a key both hold as a tree instead of replacing it. */
function joinMessages(base: object, added: object): object {
  const joined: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(added)) {
    const held = joined[key];
    joined[key] =
      typeof held === 'object' && held !== null && typeof value === 'object' && value !== null
        ? joinMessages(held, value)
        : value;
  }
  return joined;
}

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
    // A key split one level down (`environments.entities`) is half in each file, so
    // the halves are compared by the path of every message, not by top-level key.
    const eagerPaths = messagePaths(core[namespace]);
    const featurePaths = messagePaths(file[namespace] ?? {});

    it('gives its feature file exactly its own namespace', () => {
      expect(Object.keys(file)).toEqual([namespace]);
    });

    it('holds each message in exactly one of the two English files', () => {
      const doubled = eagerPaths.filter((path) => featurePaths.includes(path));

      expect(
        doubled,
        `expected no ${namespace} message in both en.ts and en-${namespace}.ts | received: ${doubled.join(', ')}`
      ).toEqual([]);
    });

    it('loses no message of the pt-BR source of truth', () => {
      expect([...eagerPaths, ...featurePaths].sort()).toEqual(messagePaths(ptBR[namespace]).sort());
      expect(
        featurePaths.length,
        `expected en-${namespace}.ts to hold messages (an empty file defers nothing) | received: none`
      ).toBeGreaterThan(0);
    });

    it('is joined back, message for message, in the complete dictionary', () => {
      const complete: object = en[namespace];

      expect(messagePaths(complete).sort()).toEqual([...eagerPaths, ...featurePaths].sort());
      expect(complete).toEqual(joinMessages(core[namespace], file[namespace] ?? {}));
    });
  });

  it('splits environments.entities and environments.machine one level down', () => {
    // Pins the nested split itself: each key is in both files with different sub-keys.
    for (const key of ['entities', 'machine'] as const) {
      const eagerSubKeys = Object.keys(core.environments[key]);
      const lazySubKeys = Object.keys(environments.environments[key]);

      expect(
        eagerSubKeys.length > 0 && lazySubKeys.length > 0,
        `expected environments.${key} in both en.ts and en-environments.ts | received: eager ${eagerSubKeys.length} sub-keys, lazy ${lazySubKeys.length}`
      ).toBe(true);
      expect(eagerSubKeys.filter((subKey) => lazySubKeys.includes(subKey))).toEqual([]);
    }
  });

  it('keeps the strings the first paint reads in the eager dictionary', () => {
    // The sidebar, the account menu and the autosave failure toast render outside
    // any settings route, so their strings must not need the settings namespace.
    expect(core.common.settings).toBe('Settings');
    expect(core.errors.settingsSaveFailed).toBeTruthy();
    expect(core.errors.settingsSaveReverted).toBeTruthy();
  });
});
