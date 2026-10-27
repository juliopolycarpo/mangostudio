/**
 * Findings rendered as sentences that state their consequence, never as codes.
 */

import type { RuntimeFinding } from '@mangostudio/shared/environments';
import { CircleAlert, CircleDashed, TriangleAlert } from 'lucide-react';

import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD } from '@/lib/icon-sizes';

import {
  describeFinding,
  type FindingSeverity,
  findingSeverity,
  isQuietFinding,
  keyedFindings,
} from '../format';
import { useToolIdentities } from '../identity/use-tool-identities';

interface FindingListProps {
  findings: readonly RuntimeFinding[];
  className?: string;
}

const SEVERITY_STYLES: Record<FindingSeverity, string> = {
  fail: 'text-danger',
  warn: 'text-warning',
};

/**
 * The single place severity turns into a glyph and a colour, so the per-runtime
 * list and the health screen can never drift into disagreeing about it.
 *
 * `quiet` is a finding the analyzer called informational: a dashed, muted ring
 * instead of the warning triangle, since an optional tool that is not there is
 * neutral and a triangle asks for something to be done.
 */
export function FindingIcon({
  severity,
  size = ICON_MD,
  quiet = false,
}: {
  severity: FindingSeverity;
  size?: number;
  quiet?: boolean;
}) {
  if (quiet && severity === 'warn') {
    return <CircleDashed size={size} className="mt-0.5 shrink-0 text-fg-muted" />;
  }
  const Icon = severity === 'fail' ? CircleAlert : TriangleAlert;
  return <Icon size={size} className={`mt-0.5 shrink-0 ${SEVERITY_STYLES[severity]}`} />;
}

export function FindingList({ findings, className = '' }: FindingListProps) {
  const { t } = useI18n();
  // A finding that names a tool must call it whatever the user calls it, or the
  // sentence stops matching the card it sits under.
  const { lookup } = useToolIdentities();

  if (findings.length === 0) return null;

  return (
    <ul className={`space-y-2 ${className}`.trim()} data-testid="finding-list">
      {keyedFindings(findings).map(({ key, finding }) => {
        const remedy = finding.params?.remedy;
        // A remedy that is itself a URL (winget's own install page, for a
        // prerequisite MangoStudio never installs) is a link a person can
        // follow, not text to read past — the sentence is built once with it
        // blanked out so the link is not duplicated inside the prose.
        const remedyLink = remedy?.startsWith('https://') ? remedy : null;
        const text = remedyLink
          ? describeFinding(
              t,
              { ...finding, params: { ...finding.params, remedy: '' } },
              lookup
            ).trim()
          : describeFinding(t, finding, lookup);

        return (
          <li
            key={key}
            className="flex items-start gap-2 text-sm text-fg-muted"
            data-finding-code={finding.code}
          >
            <FindingIcon severity={findingSeverity(finding)} quiet={isQuietFinding(finding)} />
            <span className="min-w-0">
              {text}
              {remedyLink && (
                <>
                  {' '}
                  <a
                    href={remedyLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent-fg underline"
                    data-testid="finding-remedy-link"
                  >
                    {remedyLink}
                  </a>
                </>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
