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
import { Badge } from '@/components/ui/Badge';
import { useI18n } from '@/hooks/use-i18n';
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
        <h2 className="font-headline text-lg font-bold text-on-surface">{s.title}</h2>
        <p className="text-sm text-on-surface-variant/60">{s.description}</p>
      </div>

      <ul className={`${TOOL_CARD_SURFACE} divide-y divide-outline-variant/15`}>
        {rows.map((row) => (
          <li
            key={row.id}
            className="space-y-2 p-4"
            data-testid="setup-row"
            data-setup-row={row.id}
            data-setup-status={row.status}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-on-surface">{row.label}</p>
              <Badge variant={STATUS_VARIANT[row.status]}>{s.status[row.status]}</Badge>
            </div>
            <p className="text-xs text-on-surface-variant/70">{row.explanation}</p>
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

  if (remedy.kind === 'none') return null;

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

  if (remedy.kind === 'link') {
    return (
      <Link to={remedy.to} className="text-sm font-medium text-primary hover:underline">
        {remedy.label}
      </Link>
    );
  }

  if (remedy.kind === 'copy') {
    return <CopyLine label={remedy.label} value={remedy.value} />;
  }

  return <p className="text-xs text-on-surface-variant/70">{remedy.text}</p>;
}
