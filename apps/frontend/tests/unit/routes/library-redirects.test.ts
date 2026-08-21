/**
 * The library moved under the environments umbrella, so every `/library/*` URL
 * that a user could have bookmarked is now a redirect stub. These assert the
 * forwarding target of each one — a stub that silently points at itself, or a
 * `$resourceKey` that drops its param, would strand exactly those bookmarks.
 */

import { describe, expect, it } from 'bun:test';
import { isRedirect } from '@tanstack/react-router';
import { Route as ResourceKeyRoute } from '../../../src/routes/_authenticated/library/$resourceKey';
import { Route as BackupsRoute } from '../../../src/routes/_authenticated/library/backups';
import { Route as IndexRoute } from '../../../src/routes/_authenticated/library/index';
import { Route as InstructionsRoute } from '../../../src/routes/_authenticated/library/instructions';
import { Route as SettingsRoute } from '../../../src/routes/_authenticated/library/settings';
import { Route as SkillsRoute } from '../../../src/routes/_authenticated/library/skills';
import { Route as SubagentsRoute } from '../../../src/routes/_authenticated/library/subagents';

interface RedirectOptions {
  readonly to: string;
  readonly params?: Record<string, string>;
}

interface RedirectStub {
  readonly options: { readonly beforeLoad: (context: { params?: unknown }) => void };
}

/** Runs a stub's `beforeLoad` and returns the redirect it throws. */
function followRedirect(route: unknown, params?: Record<string, string>): RedirectOptions {
  try {
    (route as RedirectStub).options.beforeLoad({ params });
  } catch (thrown) {
    if (isRedirect(thrown)) {
      return (thrown as unknown as { options: RedirectOptions }).options;
    }
    throw thrown;
  }
  throw new Error('route did not redirect');
}

describe('legacy /library routes', () => {
  it.each([
    ['index', IndexRoute, '/environments/library'],
    ['skills', SkillsRoute, '/environments/library/skills'],
    ['subagents', SubagentsRoute, '/environments/library/subagents'],
    ['instructions', InstructionsRoute, '/environments/library/instructions'],
    ['settings', SettingsRoute, '/environments/library/settings'],
    ['backups', BackupsRoute, '/environments/library/backups'],
  ])('forwards %s to its umbrella sibling', (_name, route, target) => {
    expect(followRedirect(route).to).toBe(target);
  });

  it('forwards a resource deep link with its key intact', () => {
    const resourceKey = 'skill:pdf-export';

    expect(followRedirect(ResourceKeyRoute, { resourceKey })).toMatchObject({
      to: '/environments/library/$resourceKey',
      params: { resourceKey },
    });
  });
});
