import { describe, expect, it } from 'bun:test';
import {
  parseV4aPatch,
  V4aPatchParseError,
} from '../../../../src/services/tools/builtin/_v4a-patch';

describe('parseV4aPatch', () => {
  it('parses add, update, move, and delete operations in one patch', () => {
    const parsed = parseV4aPatch(`*** Begin Patch
*** Add File: src/new.ts
+export const added = true;
*** Update File: src/old.ts
*** Move to: src/moved.ts
@@ export function run()
 const before = true;
-return before;
+return !before;
*** Delete File: src/dead.ts
*** End Patch`);

    expect(parsed.operations).toEqual([
      {
        type: 'add',
        path: 'src/new.ts',
        content: 'export const added = true;\n',
        lineNumber: 2,
      },
      {
        type: 'update',
        path: 'src/old.ts',
        moveTo: 'src/moved.ts',
        lineNumber: 4,
        hunks: [
          {
            marker: 'export function run()',
            lineNumber: 6,
            lines: [
              {
                type: 'context',
                content: 'const before = true;',
                ending: '\n',
                lineNumber: 7,
              },
              {
                type: 'delete',
                content: 'return before;',
                ending: '\n',
                lineNumber: 8,
              },
              {
                type: 'add',
                content: 'return !before;',
                ending: '\n',
                lineNumber: 9,
              },
            ],
          },
        ],
      },
      { type: 'delete', path: 'src/dead.ts', lineNumber: 10 },
    ]);
  });

  it('parses multiple implicit and explicit hunks', () => {
    const parsed = parseV4aPatch(`*** Begin Patch
*** Update File: src/app.ts
-first
+FIRST
@@ function second()
-second
+SECOND
*** End Patch`);

    const operation = parsed.operations[0];
    expect(operation?.type).toBe('update');
    if (operation?.type !== 'update') throw new Error('expected update');
    expect(operation.hunks).toHaveLength(2);
    expect(operation.hunks[0]?.marker).toBeUndefined();
    expect(operation.hunks[1]?.marker).toBe('function second()');
  });

  it('allows an empty added file and a move-only update', () => {
    const parsed = parseV4aPatch(`*** Begin Patch
*** Add File: empty.txt
*** Update File: old.txt
*** Move to: new.txt
*** End Patch`);

    expect(parsed.operations).toEqual([
      { type: 'add', path: 'empty.txt', content: '', lineNumber: 2 },
      {
        type: 'update',
        path: 'old.txt',
        moveTo: 'new.txt',
        hunks: [],
        lineNumber: 3,
      },
    ]);
  });

  it('preserves CRLF payload line endings', () => {
    const parsed = parseV4aPatch(
      '*** Begin Patch\r\n*** Add File: windows.txt\r\n+one\r\n+two\r\n*** End Patch'
    );

    expect(parsed.operations[0]).toMatchObject({
      type: 'add',
      content: 'one\r\ntwo\r\n',
    });
  });

  it.each([
    {
      name: 'missing begin envelope',
      patch: '*** Add File: x\n+y\n*** End Patch',
      line: 1,
    },
    {
      name: 'missing end envelope',
      patch: '*** Begin Patch\n*** Add File: x\n+y',
      line: 4,
    },
    {
      name: 'content after end envelope',
      patch: '*** Begin Patch\n*** Add File: x\n+y\n*** End Patch\ntrailing',
      line: 5,
    },
    {
      name: 'invalid added-file prefix',
      patch: '*** Begin Patch\n*** Add File: x\nplain\n*** End Patch',
      line: 3,
    },
    {
      name: 'invalid update prefix',
      patch: '*** Begin Patch\n*** Update File: x\nplain\n*** End Patch',
      line: 3,
    },
    {
      name: 'interleaved move directive',
      patch: '*** Begin Patch\n*** Update File: x\n-old\n+new\n*** Move to: y\n*** End Patch',
      line: 5,
    },
    {
      name: 'empty operation path',
      patch: '*** Begin Patch\n*** Delete File: \n*** End Patch',
      line: 2,
    },
    {
      name: 'empty hunk',
      patch: '*** Begin Patch\n*** Update File: x\n@@ marker\n*** End Patch',
      line: 3,
    },
    {
      name: 'context-only hunk',
      patch: '*** Begin Patch\n*** Update File: x\n same\n*** End Patch',
      line: 3,
    },
  ])('reports the line number for $name', ({ patch, line }) => {
    const error = (() => {
      try {
        parseV4aPatch(patch);
      } catch (thrown) {
        return thrown;
      }
      return null;
    })();

    expect(error).toBeInstanceOf(V4aPatchParseError);
    expect(error).toMatchObject({ lineNumber: line });
    expect((error as Error).message).toContain(`line ${line}`);
  });
});
