/**
 * The doctor rows, as the CLI prints them: a status glyph, the label, the detail.
 * Worst first, since the reason to open the list is at its top. A row that
 * carries keys is worded from this locale's dictionary; any other row, and a key
 * the dictionary does not have (a newer hub), shows the English the hub sent.
 */

import {
  type MachineCheck,
  type MachineCheckStatus,
  type MachineDoctorReport,
  resolveMachineCheckText,
} from '@mangostudio/shared/machine';
import { CircleCheck } from 'lucide-react';
import { useMemo } from 'react';

import { Badge } from '@/components/ui/Badge';
import { environmentsMessages } from '@/features/environments/environments-i18n';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_MD } from '@/lib/icon-sizes';

import { EnvironmentPageState } from '../../components/EnvironmentPageState';
import { FindingIcon } from '../../components/FindingList';
import { useMachineDoctor } from '../queries';
import { MachineCard } from './MachineCard';

const ORDER: Record<MachineCheckStatus, number> = { fail: 0, warn: 1, ok: 2 };

function sortChecks(checks: readonly MachineCheck[]): MachineCheck[] {
  return [...checks].sort((a, b) => ORDER[a.status] - ORDER[b.status]);
}

function CheckIcon({ status }: { readonly status: MachineCheckStatus }) {
  if (status === 'ok') {
    return <CircleCheck size={ICON_MD} className="mt-0.5 shrink-0 text-success" />;
  }
  return <FindingIcon severity={status} />;
}

/** The worst thing the doctor found, as the badge's tone. */
function summaryVariant(doctor: MachineDoctorReport): 'error' | 'warning' | 'success' {
  if (doctor.failures > 0) return 'error';
  return doctor.warnings > 0 ? 'warning' : 'success';
}

export function DoctorSection() {
  const { t } = useI18n(environmentsMessages);
  const m = t.environments.machine.doctor;
  const doctor = useMachineDoctor();
  // An environments row is keyed by the runtime finding's code, so its sentence
  // is the one the Environments page already shows; the finding templates sit
  // beside the doctor's own for the resolver to look both up.
  const templates = useMemo(
    () => ({ ...m.checks, ...t.environments.findings }),
    [m.checks, t.environments.findings]
  );
  const valueLabels = useMemo(() => ({ ltsStatus: t.environments.lts }), [t.environments.lts]);

  return (
    <MachineCard
      title={m.title}
      testId="machine-doctor"
      action={
        doctor.data ? (
          <Badge variant={summaryVariant(doctor.data)} data-testid="machine-doctor-summary">
            {doctor.data.failures === 0 && doctor.data.warnings === 0
              ? m.clear
              : formatMessage(m.summary, {
                  warnings: String(doctor.data.warnings),
                  failures: String(doctor.data.failures),
                })}
          </Badge>
        ) : null
      }
    >
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
          {sortChecks(doctor.data?.checks ?? []).map((check, index) => {
            // A row's own English stands in for a key this build has no text for.
            const text = resolveMachineCheckText(check, templates, valueLabels);
            return (
              <li
                // eslint-disable-next-line react/no-array-index-key -- Checks can have duplicate labels and are replaced as a list.
                key={`${index}:${check.label}`}
                className="flex items-start gap-2 text-sm"
                data-check-status={check.status}
              >
                <CheckIcon status={check.status} />
                <div className="min-w-0">
                  <span className="font-medium text-fg">{text.label}</span>
                  <span className="text-fg-muted"> — {text.detail}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </MachineCard>
  );
}
