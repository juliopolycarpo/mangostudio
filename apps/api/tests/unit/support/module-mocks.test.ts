import { describe, expect, test } from 'bun:test';

import * as peer from '../../support/mocks/module-mock-peer-subject';
import * as subject from '../../support/mocks/module-mock-subject';
import {
  moduleMockerFor,
  type ModuleRegistrar,
  registerWithBun,
  restoreMockedModules,
} from '../../support/mocks/module-mocks';

// Written against this file's directory, not the support module's: the wrapper
// has to resolve the relative specifier against `baseDir`.
const mockModule = moduleMockerFor(import.meta.dir);
const SUBJECT_SPECIFIER = '../../support/mocks/module-mock-subject';
const PEER_SPECIFIER = '../../support/mocks/module-mock-peer-subject';

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

/**
 * Registers every id with Bun except the ones it was told to refuse, which throw.
 * Stands in for a `mock.module` that fails part-way through a restore.
 */
function createRefusingModuleRegistrar(refusedIds: readonly string[]): ModuleRegistrar {
  return (id, factory) => {
    if (refusedIds.includes(id)) throw new Error(`fake registrar refused ${id}`);
    return registerWithBun(id, factory);
  };
}

describe('restoreMockedModules after a failed re-registration', () => {
  const subjectId = Bun.resolveSync(SUBJECT_SPECIFIER, import.meta.dir);
  const peerId = Bun.resolveSync(PEER_SPECIFIER, import.meta.dir);

  async function fakeSubjectThenPeer(): Promise<void> {
    // Subject first: it is the id the restore reaches first, so the bug loses the peer.
    await mockModule(SUBJECT_SPECIFIER, () => ({ subjectGreeting: () => 'fake greeting' }));
    await mockModule(PEER_SPECIFIER, () => ({ peerGreeting: () => 'fake peer greeting' }));
  }

  test('restores the ids after the failing one and keeps the failed id tracked', async () => {
    await fakeSubjectThenPeer();

    await expect(restoreMockedModules(createRefusingModuleRegistrar([subjectId]))).rejects.toThrow(
      AggregateError
    );

    expect(
      peer.peerGreeting(),
      `(${PEER_SPECIFIER}): expected the real export after the restore reached it | received a leaked fake`
    ).toBe('real peer greeting');
    expect(
      subject.subjectGreeting(),
      `(${SUBJECT_SPECIFIER}): expected the fake to stay installed because its re-registration failed`
    ).toBe('fake greeting');

    // Still pending, so the next drain (a plain call here, the global afterEach otherwise) restores it.
    await restoreMockedModules();
    expect(
      subject.subjectGreeting(),
      `(${SUBJECT_SPECIFIER}): expected the retried restore to reinstate the real module | received the fake`
    ).toBe('real greeting');
  });

  test('names every failed module id and its cause in one AggregateError', async () => {
    await fakeSubjectThenPeer();

    const error = await restoreMockedModules(
      createRefusingModuleRegistrar([subjectId, peerId])
    ).then(
      () => undefined,
      (caught: unknown) => caught
    );

    expect(
      error,
      '(restoreMockedModules): expected an AggregateError | received no rejection'
    ).toBeInstanceOf(AggregateError);
    const aggregate = error as AggregateError;
    expect(aggregate.message).toContain(subjectId);
    expect(aggregate.message).toContain(peerId);
    expect(aggregate.message).toContain(`fake registrar refused ${subjectId}`);
    expect(aggregate.errors.map((entry: Error) => entry.message)).toEqual([
      expect.stringContaining(subjectId),
      expect.stringContaining(peerId),
    ]);
    expect(aggregate.errors.map((entry: Error) => (entry.cause as Error).message)).toEqual([
      `fake registrar refused ${subjectId}`,
      `fake registrar refused ${peerId}`,
    ]);

    // Both stayed tracked; leave the process clean for the next file.
    await restoreMockedModules();
    expect([subject.subjectGreeting(), peer.peerGreeting()]).toEqual([
      'real greeting',
      'real peer greeting',
    ]);
  });
});
