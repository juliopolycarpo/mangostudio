/**
 * Test double for `@/lib/auth-client`, installed by a `tsconfig.test.json`
 * `paths` entry rather than by mocking the module.
 *
 * Why it has to exist at all: `useRealtimeInvalidation` reads the session, so
 * every component that syncs anything — environments, library, settings, git —
 * subscribes Better Auth's session atom. nanostores tears an atom down one
 * second after its last listener goes away, and that disposer removes a
 * `window` event listener. Under load the timer lands after the DOM
 * environment is gone and the run dies with an unhandled `ReferenceError:
 * window is not defined` while every test still reports green.
 *
 * Why it is a resolver alias and not `mock.module`: `bun test` shares one
 * module graph across files and `mock.restore()` does not undo `mock.module`,
 * so a global module mock leaks into unrelated suites. The alias is applied by
 * `--tsconfig-override=./tsconfig.test.json`, which `Bun.build` and `tsc` never
 * read — the stub cannot reach a production bundle.
 *
 * The default is a signed-out session, which is what the real client resolved
 * to here anyway: no test serves `/api/auth/get-session`. A test that needs a
 * session calls `setTestSession`; `bun.setup.ts` resets it after every test.
 */

export interface TestSession {
  readonly user: { readonly id: string; readonly [key: string]: unknown };
  readonly [key: string]: unknown;
}

let session: TestSession | null = null;

/** Makes `authClient.useSession()` report `next` until the next `afterEach`. */
export function setTestSession(next: TestSession | null): void {
  session = next;
}

/** Called from `bun.setup.ts`; no test should need this directly. */
export function resetTestSession(): void {
  session = null;
}

function unstubbed(method: string) {
  return () => {
    throw new Error(`authClient.${method} is not stubbed globally; substitute it in this test.`);
  };
}

export const authClient = {
  useSession: () => ({ data: session, isPending: false }),
  signIn: { email: unstubbed('signIn.email') },
  signUp: { email: unstubbed('signUp.email') },
  signOut: unstubbed('signOut'),
};
