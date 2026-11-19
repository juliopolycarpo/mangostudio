import { describe, expect, test } from 'bun:test';

import * as subject from '../../support/mocks/module-mock-subject';
import { moduleMockerFor, restoreMockedModules } from '../../support/mocks/module-mocks';

// Written against this file's directory, not the support module's: the wrapper
// has to resolve the relative specifier against `baseDir`.
const mockModule = moduleMockerFor(import.meta.dir);
const SUBJECT_SPECIFIER = '../../support/mocks/module-mock-subject';

describe('mockModule', () => {
  // Order matters: the first test fakes the module and never restores it, the
  // second runs after the global afterEach drain (test-environment.ts) and must
  // see the real module. Without the drain the fake outlives the test, which is
  // the leak this registry exists to close.
  test('fakes both exports through a partial factory', async () => {
    await mockModule(SUBJECT_SPECIFIER, () => ({ subjectGreeting: () => 'fake greeting' }));

    expect(subject.subjectGreeting()).toBe('fake greeting');
  });

  test('the next test sees the real module without restoring it itself', () => {
    expect(
      [subject.subjectGreeting(), subject.subjectFarewell()],
      '(module-mock-subject): expected the real exports after the previous test faked one | received a leaked fake'
    ).toEqual(['real greeting', 'real farewell']);
  });

  test('restores every export a partial fake did not name', async () => {
    await mockModule(SUBJECT_SPECIFIER, () => ({ subjectFarewell: () => 'fake farewell' }));
    expect(subject.subjectFarewell()).toBe('fake farewell');

    await restoreMockedModules();

    expect([subject.subjectGreeting(), subject.subjectFarewell()]).toEqual([
      'real greeting',
      'real farewell',
    ]);
  });

  test('a second fake after a restore still restores to the real module', async () => {
    await mockModule(SUBJECT_SPECIFIER, () => ({ subjectGreeting: () => 'first fake' }));
    await restoreMockedModules();
    await mockModule(SUBJECT_SPECIFIER, () => ({ subjectGreeting: () => 'second fake' }));
    await restoreMockedModules();

    expect(subject.subjectGreeting()).toBe('real greeting');
  });

  test('names the specifier and base directory when a relative one does not resolve', async () => {
    const result = mockModule('./does-not-exist-anywhere', () => ({}));

    await expect(result).rejects.toThrow(
      `mockModule: expected a specifier that resolves from ${import.meta.dir} | received: ./does-not-exist-anywhere`
    );
  });

  test('restoring with nothing faked is a no-op', async () => {
    await restoreMockedModules();

    expect(subject.subjectGreeting()).toBe('real greeting');
  });
});
