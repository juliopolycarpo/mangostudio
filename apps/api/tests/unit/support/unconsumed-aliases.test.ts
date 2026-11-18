import { describe, expect, it } from 'bun:test';

import { findUnconsumedAliases } from '../../support/unconsumed-aliases';

/** Serves fixed texts by path and records every read, so a test can see what was skipped. */
class FakeSourceTexts {
  readonly reads: string[] = [];

  constructor(private readonly texts: Readonly<Record<string, string>>) {}

  readonly paths = (): string[] => Object.keys(this.texts);

  readonly read = (path: string): Promise<string> => {
    this.reads.push(path);
    const text = this.texts[path];
    if (text === undefined)
      return Promise.reject(new Error(`expected a fixture path | received: ${path}`));
    return Promise.resolve(text);
  };
}

describe('findUnconsumedAliases', () => {
  it('reports a dead alias and not a used one', async () => {
    const files = new FakeSourceTexts({
      'src/repo.ts': "import type { ChatTodoSelect } from '../db/types';",
      'tests/repo.test.ts': 'const row: ChatTodoInsert = {};',
    });

    const received = await findUnconsumedAliases(
      ['ChatTodoSelect', 'ChatTodoInsert', 'ChatTodoUpdate'],
      files.paths(),
      files.read
    );

    expect(
      received,
      `expected unused aliases: ChatTodoUpdate | received: ${received.join(', ')}`
    ).toEqual(['ChatTodoUpdate']);
  });

  it('matches whole words only, so a longer or prefixed identifier is not a consumer', async () => {
    const files = new FakeSourceTexts({
      'src/near-miss.ts':
        'type A = ChatTodoSelectRow; type B = MyChatTodoSelect; const ChatTodoSelect2 = 1;',
    });

    const received = await findUnconsumedAliases(['ChatTodoSelect'], files.paths(), files.read);

    expect(received).toEqual(['ChatTodoSelect']);
  });

  it('counts a word next to punctuation as a consumer', async () => {
    const files = new FakeSourceTexts({ 'src/a.ts': 'Array<ChatTodoSelect>' });

    expect(await findUnconsumedAliases(['ChatTodoSelect'], files.paths(), files.read)).toEqual([]);
  });

  it('keeps the declared order of several dead aliases', async () => {
    const files = new FakeSourceTexts({ 'src/a.ts': 'nothing here' });

    const received = await findUnconsumedAliases(['ZSelect', 'ASelect'], files.paths(), files.read);

    expect(received).toEqual(['ZSelect', 'ASelect']);
  });

  it('stops reading once every alias has a consumer', async () => {
    const trailing = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [`tests/late-${index}.ts`, 'unrelated'])
    );
    const files = new FakeSourceTexts({
      'src/first.ts': 'ChatTodoSelect ChatTodoInsert',
      ...trailing,
    });

    const received = await findUnconsumedAliases(
      ['ChatTodoSelect', 'ChatTodoInsert'],
      files.paths(),
      files.read
    );

    expect(received).toEqual([]);
    expect(
      files.reads.length,
      `expected reads within the first round of 64 | received: ${files.reads.length}`
    ).toBeLessThanOrEqual(64);
  });

  it('reads every path when one alias stays dead', async () => {
    const trailing = Object.fromEntries(
      Array.from({ length: 150 }, (_, index) => [`tests/late-${index}.ts`, 'unrelated'])
    );
    const files = new FakeSourceTexts({ 'src/first.ts': 'ChatTodoSelect', ...trailing });

    const received = await findUnconsumedAliases(
      ['ChatTodoSelect', 'ChatTodoUpdate'],
      files.paths(),
      files.read
    );

    expect(received).toEqual(['ChatTodoUpdate']);
    expect(files.reads).toHaveLength(151);
  });

  it('reads nothing when there are no aliases', async () => {
    const files = new FakeSourceTexts({ 'src/a.ts': 'x' });

    expect(await findUnconsumedAliases([], files.paths(), files.read)).toEqual([]);
    expect(files.reads).toEqual([]);
  });

  it('surfaces an unreadable path with its name', async () => {
    const read = (path: string): Promise<string> => Promise.reject(new Error(`denied ${path}`));

    await expect(
      findUnconsumedAliases(['ChatTodoSelect'], ['src/locked.ts'], read)
    ).rejects.toThrow('API source file "src/locked.ts": expected readable text');
  });
});
