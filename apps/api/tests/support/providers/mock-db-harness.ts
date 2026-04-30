/**
 * Builds a chainable in-memory Kysely mock for route-level integration tests.
 *
 * Supports three query families:
 *   - selectFrom → where → orderBy → limit → execute / executeTakeFirst
 *   - insertInto → values → execute
 *   - updateTable → set → where → execute
 *
 * All chain methods return a Proxy that resolves to `executeTakeFirst` or
 * `execute` at the terminal.
 */

interface MockDbOptions {
  /** Value returned by selectFrom(...).executeTakeFirst()  */
  selectFirst?: unknown;
  /** Value returned by selectFrom(...).execute()  */
  selectAll?: unknown[];
  /** Callback invoked on every insertInto('messages').values() call. */
  onInsertMessage?: (values: Record<string, unknown>) => void;
  /** Callback invoked on every updateTable('chats').set() call. */
  onUpdateChat?: (values: Record<string, unknown>) => void;
}

function makeChain(firstValue: unknown, listValue: unknown[]): Record<string, unknown> {
  const terminal: Record<string, unknown> = {
    execute: () => Promise.resolve(listValue),
    executeTakeFirst: () => Promise.resolve(firstValue),
  };
  const proxy = new Proxy(terminal, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      return () => proxy;
    },
  });
  return proxy;
}

/**
 * Creates a mock `getDb` return value for use with `mock.module`.
 *
 * @example
 * await mock.module('../../../src/db/database', () => ({
 *   getDb: createMockDbHarness({ selectFirst: { userId: 'u1' } }),
 * }));
 */
export function createMockDbHarness(options: MockDbOptions = {}) {
  const { selectFirst, selectAll = [], onInsertMessage, onUpdateChat } = options;

  return () => ({
    selectFrom: (_table: string) => makeChain(selectFirst, selectAll),
    insertInto: (table: string) => ({
      values: (values: Record<string, unknown>) => {
        if (table === 'messages' && onInsertMessage) {
          onInsertMessage(values);
        }
        return { execute: () => Promise.resolve() };
      },
    }),
    updateTable: (_table: string) => ({
      set: (values: Record<string, unknown>) => {
        if (onUpdateChat) {
          onUpdateChat(values);
        }
        return makeChain(undefined, []);
      },
    }),
  });
}
