/**
 * The Overview's "before you start" checklist: what a new machine needs and
 * the one affordance that clears each row. Aimed at someone who is not an
 * expert on this stack — a status word, a one-line reason, and a single next
 * action, never a second diagnostic to read.
 */

import type {
  AgentCliStatus,
  InstallRecipePreview,
  RuntimeStatus,
} from '@mangostudio/shared/environments';
import type { MachineStatus } from '@mangostudio/shared/machine';
import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { buttonClassName } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';

import { buildSetupRows, type SetupRow, type SetupRowStatus } from '../setup-checklist';
import { CopyLine } from './CopyLine';
import { InstallAction } from './InstallAction';
import { TOOL_CARD_SURFACE } from './ToolCard';

interface SetupChecklistProps {
  readonly runtimes: readonly RuntimeStatus[];
  readonly agents: readonly AgentCliStatus[];
  readonly recipes: readonly InstallRecipePreview[];
  readonly machine: MachineStatus | undefined;
}

const STATUS_VARIANT: Record<SetupRowStatus, 'success' | 'warning' | 'neutral'> = {
  done: 'success',
  todo: 'warning',
  optional: 'neutral',
};

export function SetupChecklist({ runtimes, agents, recipes, machine }: SetupChecklistProps) {
  const { t } = useI18n();
  const s = t.environments.overview.setup;
  const rows = buildSetupRows(t, runtimes, agents, recipes, machine);

  return (
    <section className="space-y-3" data-testid="setup-checklist">
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-fg">{s.title}</h2>
        <p className="text-sm text-fg-muted">{s.description}</p>
      </div>

      <ul className={`${TOOL_CARD_SURFACE} divide-y divide-stroke`}>
        {rows.map((row) => (
          <li
            key={row.id}
            className="space-y-3 p-4"
            data-testid="setup-row"
            data-setup-row={row.id}
            data-setup-status={row.status}
          >
            <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
              <div className="min-w-0 flex-1 basis-56 space-y-1">
                <p className="text-sm font-medium text-fg">{row.label}</p>
                <p className="text-xs text-fg-muted">{row.explanation}</p>
              </div>
              {/* The tab that clears the row sits at its trailing edge, drawn the
                  way the Health page draws it, before the badge so the badges
                  keep one column whether or not a row has a link. */}
              <div className="flex shrink-0 items-center gap-2">
                {row.remedy.kind === 'link' && (
                  <Link
                    to={row.remedy.to}
                    className={buttonClassName('subtle', 'sm')}
                    data-testid="setup-row-link"
                  >
                    {row.remedy.label}
                    <ChevronRight size={ICON_SM} aria-hidden="true" />
                  </Link>
                )}
                <Badge variant={STATUS_VARIANT[row.status]}>{s.status[row.status]}</Badge>
              </div>
            </div>
            <SetupRowRemedy row={row} recipes={recipes} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function SetupRowRemedy({
  row,
  recipes,
}: {
  readonly row: SetupRow;
  readonly recipes: readonly InstallRecipePreview[];
}) {
  const { remedy } = row;

  // A link is drawn in the row's trailing edge, beside the badge.
  if (remedy.kind === 'none' || remedy.kind === 'link') return null;

  if (remedy.kind === 'install') {
    return (
      <InstallAction
        recipe={remedy.step.recipe}
        input={remedy.step.input}
        {...(remedy.followUp && { followUpSteps: remedy.followUp })}
        catalog={recipes}
        label={remedy.label}
      />
    );
  }

  if (remedy.kind === 'copy') {
    return <CopyLine label={remedy.label} value={remedy.value} />;
  }

  return <p className="text-xs text-fg-muted">{remedy.text}</p>;
}
