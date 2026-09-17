/**
 * Windows opens a console window for every child process unless told
 * otherwise. Spreading this into a spawn's options is the one spelling for
 * that everywhere a child is started, hub or runtime side; a guard test in
 * each app enforces that every spawn site uses it.
 */
export const HIDDEN_WINDOW = { windowsHide: true } as const;
