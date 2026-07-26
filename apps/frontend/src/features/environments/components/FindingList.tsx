/**
 * Findings rendered as sentences that state their consequence, never as codes.
 */

import type { RuntimeFinding } from '@mangostudio/shared/environments';
import { CircleAlert, TriangleAlert } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';
import { describeFinding, findingSeverity, keyedFindings } from '../format';

interface FindingListProps {
  findings: readonly RuntimeFinding[];
  className?: string;
}

const SEVERITY_STYLES = {
  fail: 'text-error',
  warn: 'text-tertiary',
} as const;

export function FindingList({ findings, className = '' }: FindingListProps) {
  const { t } = useI18n();

  if (findings.length === 0) return null;

  return (
    <ul className={`space-y-2 ${className}`.trim()} data-testid="finding-list">
      {keyedFindings(findings).map(({ key, finding }) => {
        const severity = findingSeverity(finding);
        const Icon = severity === 'fail' ? CircleAlert : TriangleAlert;
        return (
          <li
            key={key}
            className="flex items-start gap-2 text-sm text-on-surface-variant"
            data-finding-code={finding.code}
          >
            <Icon size={16} className={`mt-0.5 shrink-0 ${SEVERITY_STYLES[severity]}`} />
            <span className="min-w-0">{describeFinding(t, finding)}</span>
          </li>
        );
      })}
    </ul>
  );
}
