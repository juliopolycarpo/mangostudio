/**
 * Windows opens a console window for every child process unless told
 * otherwise. Spreading this into a spawn's options is the one spelling for
 * that everywhere the hub starts a child. A guard test walks the real source
 * trees and asserts it at every call site —
 * `apps/api/tests/unit/lib/hidden-window.test.ts` covers the hub and this
 * workspace — so a spawn added here is covered like any other.
 */
export const HIDDEN_WINDOW = { windowsHide: true } as const;
