/**
 * Windows opens a console window for every child process unless told
 * otherwise. Spreading this into a spawn's options is the one spelling for
 * that everywhere a child is started, hub or runtime side. Two guard tests
 * walk the real source trees and assert it at every call site —
 * `apps/api/tests/unit/lib/hidden-window.test.ts` covers the hub and this
 * workspace, `apps/runtime/tests/unit/services/hidden-window.test.ts` the
 * runtime — so a spawn added here is covered like any other.
 */
export const HIDDEN_WINDOW = { windowsHide: true } as const;
