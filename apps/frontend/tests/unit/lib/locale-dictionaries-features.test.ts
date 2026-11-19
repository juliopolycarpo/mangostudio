/**
 * Feature namespaces in the locale dictionary: the eager English dictionary
 * holds only part of `library`, `git`, `github` and `environments`, a feature's
 * lazy chunk brings the rest as a value (no request), and a dictionary that is
 * already complete is never overwritten with English.
 */

import { describe, expect, it } from 'bun:test';

import { en, ptBR } from '@mangostudio/shared/i18n';
import { messages as gitMessages } from '@mangostudio/shared/i18n/en-git';
import { messages as libraryMessages } from '@mangostudio/shared/i18n/en-library';

import { carriesFeatureKeys, withFeatureMessages } from '../../../src/lib/locale-dictionaries';
import { englishWithoutDeferredNamespaces as eager } from '../../support/mocks/fake-locale-dictionaries';

describe('the eager English dictionary and the feature namespaces', () => {
  it('holds the keys the first paint reads and leaves the feature-only ones out', () => {
    expect(eager.library.targets.claude).toBe(en.library.targets.claude);
    expect(
      'removal' in eager.library,
      `expected the eager dictionary to leave library.removal to the Library chunk | received: present`
    ).toBe(false);
    expect(
      'branch' in eager.git,
      'expected git.branch to be absent from the eager dictionary'
    ).toBe(false);
  });

  it('does not carry the feature keys until a feature chunk adds them', () => {
    expect(carriesFeatureKeys(eager, libraryMessages)).toBe(false);
    expect(carriesFeatureKeys(eager, gitMessages)).toBe(false);
  });
});

describe('withFeatureMessages', () => {
  it('adds the feature keys to the eager English dictionary and keeps the eager ones', () => {
    const loaded = withFeatureMessages(eager, libraryMessages);

    expect(loaded.library.removal).toEqual(en.library.removal);
    expect(loaded.library.targets).toBe(eager.library.targets);
    expect(loaded.auth).toBe(eager.auth);
  });

  it('leaves the eager dictionary itself untouched', () => {
    withFeatureMessages(eager, libraryMessages);

    expect('removal' in eager.library).toBe(false);
  });

  it('returns the same object for the same arguments, so it is safe in a dependency list', () => {
    expect(withFeatureMessages(eager, libraryMessages)).toBe(
      withFeatureMessages(eager, libraryMessages)
    );
  });

  it('merges each feature independently and in any order to the same keys', () => {
    const libraryThenGit = withFeatureMessages(
      withFeatureMessages(eager, libraryMessages),
      gitMessages
    );
    const gitThenLibrary = withFeatureMessages(
      withFeatureMessages(eager, gitMessages),
      libraryMessages
    );

    expect(libraryThenGit.library.removal).toEqual(en.library.removal);
    expect(libraryThenGit.git.branch).toEqual(en.git.branch);
    expect(gitThenLibrary.library).toEqual(libraryThenGit.library);
    expect(gitThenLibrary.git).toEqual(libraryThenGit.git);
  });

  it('returns a complete dictionary as is, so a lazy locale keeps its own text', () => {
    const loaded = withFeatureMessages(ptBR, libraryMessages);

    expect(loaded).toBe(ptBR);
    expect(loaded.library.removal).toEqual(ptBR.library.removal);
    expect(loaded.library.removal).not.toEqual(en.library.removal);
  });

  it('reports a complete dictionary as carrying the keys', () => {
    expect(carriesFeatureKeys(ptBR, libraryMessages)).toBe(true);
    expect(carriesFeatureKeys(en, libraryMessages)).toBe(true);
    expect(carriesFeatureKeys(withFeatureMessages(eager, libraryMessages), libraryMessages)).toBe(
      true
    );
  });
});
