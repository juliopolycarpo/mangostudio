import type { ReactNode } from 'react';

/**
 * The shell the inbox, pull request and issue rows share: a `rounded-sm` row
 * with a neutral hover wash. `group` lets the row's overflow menu reveal itself
 * on hover, and the negative margin lets the text line up with the section's
 * own edge while the wash reaches a little past it.
 *
 * @example
 * <GithubRowShell><button className="min-w-0 flex-1 text-left">…</button><GithubRowMenu … /></GithubRowShell>
 */
export function GithubRowShell({ children }: { readonly children: ReactNode }) {
  return (
    <li className="group -mx-2 flex items-start gap-2 rounded-sm px-2 py-1.5 transition-colors hover:bg-fill-hover">
      {children}
    </li>
  );
}
