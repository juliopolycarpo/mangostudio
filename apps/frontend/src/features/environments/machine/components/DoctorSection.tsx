/**
 * The doctor rows, exactly as the CLI prints them: label, badge, detail.
 * Worst first, since the reason to open the list is at its top.
 */

import type { MachineCheck, MachineCheckStatus } from '@mangostudio/shared/machine';
import { CircleCheck } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { EnvironmentPageState } from '../../components/EnvironmentPageState';
import { FindingIcon } from '../../components/FindingList';
import { CardSectionLabel, TOOL_CARD_SURFACE } from '../../components/ToolCard';
import { useMachineDoctor } from '../queries';

const ORDER: Record<MachineCheckStatus, number> = { fail: 0, warn: 1, ok: 2 };

function sortChecks(checks: readonly MachineCheck[]): MachineCheck[] {
  return [...checks].sort((a, b) => ORDER[a.status] - ORDER[b.status]);
}

function CheckIcon({ status }: { readonly status: MachineCheckStatus }) {
  if (status === 'ok') return <CircleCheck size={16} className="mt-0.5 shrink-0 text-primary" />;
  return <FindingIcon severity={status} />;
}

export function DoctorSection() {
  const { t } = useI18n();
  const m = t.environments.machine.doctor;
  const doctor = useMachineDoctor();

  return (
    <section className={`${TOOL_CARD_SURFACE} space-y-4 p-5`} data-testid="machine-doctor">
      <div className="flex items-baseline justify-between gap-3">
        <CardSectionLabel>{m.title}</CardSectionLabel>
        {doctor.data && (
          <p className="text-xs text-on-surface-variant/70" data-testid="machine-doctor-summary">
            {doctor.data.failures === 0 && doctor.data.warnings === 0
              ? m.clear
              : formatMessage(m.summary, {
                  warnings: String(doctor.data.warnings),
                  failures: String(doctor.data.failures),
                })}
          </p>
        )}
      </div>

      {doctor.isPending && !doctor.data ? (
        <EnvironmentPageState variant="loading" size="section" />
      ) : doctor.error && !doctor.data ? (
        <EnvironmentPageState
          variant="error"
          size="section"
          onRetry={() => void doctor.refetch()}
        />
      ) : (
        <ul className="space-y-2">
          {/* Position keys the rows: two checks can share a label and a detail
              (a second MCP server with the same name and the same finding), and
              a duplicate key drops one of them. The list is fully replaced on
              every fetch, so there is no identity to preserve across renders. */}
          {sortChecks(doctor.data?.checks ?? []).map((check, index) => (
            <li
              key={`${index}:${check.label}`}
              className="flex items-start gap-2 text-sm"
              data-check-status={check.status}
            >
              <CheckIcon status={check.status} />
              <div className="min-w-0">
                <span className="font-bold text-on-surface">{check.label}</span>
                <span className="text-on-surface-variant"> — {check.detail}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
