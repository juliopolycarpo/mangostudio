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

/**
 * Every method seam takes the whole function rather than a result: the auth
 * surfaces drive both halves of a Better Auth call — what it resolves to and
 * the `fetchOptions.onError` callback it may invoke instead.
 */
export type TestAuthMethod = (...args: never[]) => unknown;

let session: TestSession | null = null;
const methods: Record<'signIn' | 'signUp' | 'signOut', TestAuthMethod | null> = {
  signIn: null,
  signUp: null,
  signOut: null,
};

/** Makes `authClient.useSession()` report `next` until the next `afterEach`. */
export function setTestSession(next: TestSession | null): void {
  session = next;
}

/** Substitutes `authClient.signIn.email` for one test. */
export function setTestSignIn(next: TestAuthMethod | null): void {
  methods.signIn = next;
}

/** Substitutes `authClient.signUp.email` for one test. */
export function setTestSignUp(next: TestAuthMethod | null): void {
  methods.signUp = next;
}

/** Substitutes `authClient.signOut` for one test. */
export function setTestSignOut(next: TestAuthMethod | null): void {
  methods.signOut = next;
}

/**
 * Clears the session and every method substitution.
 *
 * Called from `bun.setup.ts`; no test should need this directly.
 */
export function resetTestSession(): void {
  session = null;
  methods.signIn = null;
  methods.signUp = null;
  methods.signOut = null;
}

/**
 * Dispatches to whatever the test installed, and names the missing seam
 * otherwise. Reading `methods` per call rather than closing over it is what
 * lets a substitution registered in `beforeEach` reach a component that read
 * `authClient` at import time.
 */
function seam(name: 'signIn' | 'signUp' | 'signOut') {
  return (...args: never[]): unknown => {
    const substitute = methods[name];
    if (!substitute) {
      throw new Error(
        `authClient.${name} is not stubbed globally; call setTest${name[0].toUpperCase()}${name.slice(1)} in this test.`
      );
    }
    return substitute(...args);
  };
}

export const authClient = {
  useSession: () => ({ data: session, isPending: false }),
  signIn: { email: seam('signIn') },
  signUp: { email: seam('signUp') },
  signOut: seam('signOut'),
};
