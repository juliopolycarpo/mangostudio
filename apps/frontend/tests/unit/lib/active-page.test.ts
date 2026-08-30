/**
 * The shell keys its route transition on this, so the mapping is the thing
 * that decides which navigations animate. The cases that matter are the ones
 * that must resolve to the *same* page: a chat switch and a settings tab both
 * have to hold their key, or the transition replays over a virtualized feed
 * and a settings pane that never left the screen.
 */

import { describe, expect, it } from 'bun:test';
import { activePageForPath } from '@/lib/active-page';

describe('activePageForPath', () => {
  it('maps each top-level destination', () => {
    expect(activePageForPath('/home')).toBe('home');
    expect(activePageForPath('/gallery')).toBe('gallery');
    expect(activePageForPath('/settings')).toBe('settings');
    expect(activePageForPath('/studio')).toBe('studio');
    expect(activePageForPath('/environments')).toBe('environments');
  });

  it('falls back to chat, which owns the index route', () => {
    expect(activePageForPath('/')).toBe('chat');
    expect(activePageForPath('/anything-unrouted')).toBe('chat');
  });

  it('holds one key across every settings tab', () => {
    const tabs = ['/settings/general', '/settings/appearance', '/settings/providers/openai'];
    expect(tabs.map(activePageForPath)).toEqual(['settings', 'settings', 'settings']);
  });

  it('holds one key across every environments and library sub-route', () => {
    // `/library/*` redirects into the umbrella; it must not flash a different
    // nav entry while the redirect resolves.
    const routes = [
      '/environments',
      '/environments/agents',
      '/environments/library/skills',
      '/environments/library/commands',
      '/library/anything',
    ];
    expect(new Set(routes.map(activePageForPath))).toEqual(new Set(['environments']));
  });

  it('keeps the precedence of the fall-through chain it replaced', () => {
    // The original ran a run of `if`s with no early return, so the last match
    // won. `/environments/library/*` holds both segments and resolved to
    // environments; reversing the checks into early returns has to preserve
    // that, not the order they happen to read best in.
    expect(activePageForPath('/environments/library/settings')).toBe('environments');
    expect(activePageForPath('/environments/library/instructions')).toBe('environments');
  });
});
