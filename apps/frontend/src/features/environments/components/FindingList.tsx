/**
 * Findings rendered as sentences that state their consequence, never as codes.
 */

import type { RuntimeFinding } from '@mangostudio/shared/environments';
import { CircleAlert, TriangleAlert } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';
import { describeFinding, type FindingSeverity, findingSeverity, keyedFindings } from '../format';

interface FindingListProps {
  findings: readonly RuntimeFinding[];
  className?: string;
}

const SEVERITY_STYLES: Record<FindingSeverity, string> = {
  fail: 'text-error',
  warn: 'text-tertiary',
};

/**
 * The single place severity turns into a glyph and a colour, so the per-runtime
 * list and the health screen can never drift into disagreeing about it.
 */
export function FindingIcon({ severity, size = 16 }: { severity: FindingSeverity; size?: number }) {
  const Icon = severity === 'fail' ? CircleAlert : TriangleAlert;
  return <Icon size={size} className={`mt-0.5 shrink-0 ${SEVERITY_STYLES[severity]}`} />;
}

export function FindingList({ findings, className = '' }: FindingListProps) {
  const { t } = useI18n();

  if (findings.length === 0) return null;

  return (
    <ul className={`space-y-2 ${className}`.trim()} data-testid="finding-list">
      {keyedFindings(findings).map(({ key, finding }) => (
        <li
          key={key}
          className="flex items-start gap-2 text-sm text-on-surface-variant"
          data-finding-code={finding.code}
        >
          <FindingIcon severity={findingSeverity(finding)} />
          <span className="min-w-0">{describeFinding(t, finding)}</span>
        </li>
      ))}
    </ul>
  );
}
