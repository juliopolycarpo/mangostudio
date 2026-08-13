/**
 * The Eden seam: what `treaty<App>` still knows about the API.
 *
 * This is the only place the frontend's types come from the backend's routes.
 * It is also the quietest thing in the repository to break — when Eden loses
 * hold of `App`, every route collapses to `any` and the application keeps
 * compiling. Wrong field names, wrong body shapes, and removed endpoints all
 * become runtime bugs, and no other test notices, because `any` satisfies
 * every assertion anyone would write against it.
 *
 * So these are compile-time assertions with a token runtime body. `tsc` is the
 * thing actually running them, under `bun run check`; the `expect` at the end
 * only keeps the file honest as a test.
 */

import { describe, expect, it } from 'vitest';
import { client } from '../../../src/lib/api-client';

/**
 * `true` only when `A` and `B` are mutually assignable. Declared here rather
 * than imported: `@mangostudio/shared/test-utils` does not re-export shared's
 * copy, and this is the only frontend file that needs it.
 */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Fails the typecheck unless the supplied condition is exactly `true`. */
function assertType<_T extends true>(): void {
  // Compile-time only: the type parameter constraint does the work.
}

/** True only for `any` — `0 extends 1 & T` holds for nothing else. */
type IsAny<T> = 0 extends 1 & T ? true : false;

type HealthResponse = Awaited<ReturnType<typeof client.api.health.get>>;
type ChatsPostBody = Parameters<typeof client.api.chats.post>[0];
type ChatsPostResponse = Awaited<ReturnType<typeof client.api.chats.post>>;
type ChatsGetResponse = Awaited<ReturnType<typeof client.api.chats.get>>;

// 1. The `/api` namespace still exists as a namespace. `treaty<App>` only
//    produces it when it can read the prefixed sub-instance out of `App`; a
//    client that lost the type would make this `any`.
assertType<Equals<IsAny<typeof client.api>, false>>();
assertType<Equals<IsAny<HealthResponse>, false>>();

// 2. A representative GET keeps its response shape. The health route declares
//    no response schema, so Eden unions the handler's return with the shared
//    error body — that union *is* the contract, and flattening it to `unknown`
//    is the failure this catches.
assertType<
  Equals<
    HealthResponse['data'],
    | { error: string; code?: string; details?: { [x: string]: string } }
    | { status: string; timestamp: number }
    | null
  >
>();

// 3. The transport-level error channel stays typed rather than becoming `any`.
assertType<Equals<HealthResponse['error'], { status: unknown; value: unknown } | null>>();

// 4. A schema-backed POST keeps its request body exactly as the TypeBox schema
//    declares it: `title` required, `model` optional. This is the direction
//    that matters most — an `any` body accepts every typo silently.
assertType<Equals<ChatsPostBody, { title: string; model?: string }>>();

// 5. And its response keeps the full entity, including the discriminated
//    `runner` union and the template-literal agent id. That id survives a
//    `Type.Unsafe` in the shared schema, so it is the single best proof that
//    precise types cross the whole chain — schema, route, Eden, component.
type ChatData = NonNullable<ChatsPostResponse['data']>;
assertType<Equals<IsAny<ChatData>, false>>();
assertType<
  Equals<
    Extract<ChatData['runner'], { kind: 'mangostudio' }>['agentId'],
    'default' | 'explore' | `user:${string}`
  >
>();

// 6. A list route stays an array of the same entity rather than `unknown[]`.
assertType<Equals<ChatsGetResponse['data'], ChatData[] | null>>();

// 7. The socket-adjacent route is still reachable through the same client, so
//    a WebSocket route dropping out of `App` fails here rather than at runtime.
assertType<Equals<IsAny<typeof client.api.ws.subscribe>, false>>();
assertType<
  Equals<typeof client.api.ws.subscribe extends (...args: never) => unknown ? true : false, true>
>();

describe('Eden treaty type seam', () => {
  it('keeps route input and output types inferable from App', () => {
    // The assertions above are enforced by `tsc --noEmit`. Reaching this body
    // at all means the client module loaded and every one of them compiled.
    expect(typeof client.api.chats.post).toBe('function');
    expect(typeof client.api.health.get).toBe('function');
    expect(typeof client.api.ws.subscribe).toBe('function');
  });
});
