/**
 * The English dictionary is shipped in pieces: an eager part that rides in the
 * frontend's entry chunk, and the deferred namespaces (`settings`, `onboarding`)
 * that load with the routes reading them. These tests pin the split: nothing
 * deferred in the eager part, each deferred file owns exactly its namespace, and
 * the barrel's complete `en` is the union with no key lost or doubled.
 */

import { describe, expect, it } from 'bun:test';

import { en, ptBR } from '../../src/i18n';
import { messages as core } from '../../src/i18n/en';
import { messages as onboarding } from '../../src/i18n/en-onboarding';
import { messages as settings } from '../../src/i18n/en-settings';
import type { DeferredNamespace } from '../../src/i18n/types';

const DEFERRED: readonly DeferredNamespace[] = ['settings', 'onboarding'];

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

  it('keeps the strings the first paint reads in the eager dictionary', () => {
    // The sidebar, the account menu and the autosave failure toast render outside
    // any settings route, so their strings must not need the settings namespace.
    expect(core.common.settings).toBe('Settings');
    expect(core.errors.settingsSaveFailed).toBeTruthy();
    expect(core.errors.settingsSaveReverted).toBeTruthy();
  });
});
