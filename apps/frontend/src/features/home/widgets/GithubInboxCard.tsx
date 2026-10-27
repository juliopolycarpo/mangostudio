/**
 * Pull requests waiting on this account's review, on the dashboard.
 *
 * Silent by default, on `EnvironmentHealthCard`'s rule: nothing waiting means
 * no card, not an empty one. That rule matters more here than elsewhere,
 * because the four not-connected states are the *normal* answer for most
 * accounts — `gh` is not installed, or not signed in — and a dashboard that
 * explains a missing CLI every morning to somebody who does not use GitHub is
 * noise on a screen whose whole promise is that everything on it is worth
 * reading.
 *
 * Rows link straight to GitHub rather than into the rail panel: an inbox row is
 * a pull request in another repository, so there is no local chat whose panel
 * could show it.
 */

import { useQuery } from '@tanstack/react-query';

import { SectionCard } from '@/components/ui/SectionCard';
import { githubInboxQueryOptions } from '@/features/github/queries';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';

/** Enough to notice, few enough that the card stays a card. */
const HOME_INBOX_ROWS = 5;

export function GithubInboxCard() {
  const { t } = useI18n();
  const query = useQuery(githubInboxQueryOptions());
  const data = query.data;

  // Loading, failed, not connected, and nothing waiting all render the same
  // way: not at all.
  if (data?.state !== 'ok' || data.items.length === 0) return null;

  return (
    <SectionCard label={t.home.github.label} tone="warning">
      <ul className="-mx-2 space-y-0.5">
        {data.items.slice(0, HOME_INBOX_ROWS).map((item) => (
          <li key={item.url} className="min-w-0">
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block min-w-0 rounded-sm px-2 py-1 transition-colors hover:bg-fill-hover"
            >
              <span className="block truncate text-sm text-fg">{item.title}</span>
              <span className="block truncate font-mono text-micro text-fg-subtle">
                {formatMessage(t.home.github.row, {
                  repo: item.repository.nameWithOwner,
                  number: String(item.number),
                })}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
