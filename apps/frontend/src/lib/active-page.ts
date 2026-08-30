import type { AppPage } from '@/hooks/use-chat-route-actions';

/**
 * Which top-level destination a pathname belongs to.
 *
 * Two things read this: the nav, to mark an entry current, and the shell's
 * route transition, which keys on it. That second use is why it maps to a
 * *destination* rather than to a route — everything under `/settings` is one
 * page here, and every chat is the same page as every other chat. A key that
 * tracked the pathname would replay the transition on each chat switch and on
 * every settings tab, which is exactly the laggy, fights-the-virtualizer
 * behaviour a page transition must not have.
 *
 * Tested order, not tidy order. This replaced a run of fall-through `if`s where
 * the last match won, so the checks are reversed to keep that precedence: a
 * path holding two of these segments must still resolve the way it used to.
 *
 * // Usage: activePageForPath('/settings/general') // => 'settings'
 */
export function activePageForPath(pathname: string): AppPage {
  // `/library/*` only ever redirects into the umbrella now, but it stays mapped
  // so the nav does not flash a different entry while the redirect resolves.
  if (pathname.includes('/environments') || pathname.includes('/library')) return 'environments';
  if (pathname.includes('/studio')) return 'studio';
  if (pathname.includes('/settings')) return 'settings';
  if (pathname.includes('/gallery')) return 'gallery';
  if (pathname.includes('/home')) return 'home';
  return 'chat';
}
