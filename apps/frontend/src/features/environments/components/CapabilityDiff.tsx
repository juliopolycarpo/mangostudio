/**
 * Two machines, side by side.
 *
 * This is the view the whole environments umbrella exists to make possible:
 * "git on Windows but not in WSL, PowerShell on Windows, not in WSL" is one
 * table, not two tabs and a memory. It is a read-only composition of data both
 * columns already fetched — no new endpoint, no new cache.
 *
 * A cell has three states, not two. "Not installed" and "not reported" lead to
 * completely different actions: one is a thing to install, the other is a
 * machine that will not answer the question, and collapsing them into a shared
 * empty cell would send someone installing software that is already there.
 */

import type { AgentCliStatus, Environment, RuntimeStatus } from '@mangostudio/shared/environments';
import { useQueries } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';
import { useToolIdentities } from '../identity/use-tool-identities';
import { agentCliStatusesQueryOptions, runtimeStatusesQueryOptions } from '../queries';
import { EnvironmentPageState } from './EnvironmentPageState';

interface CapabilityDiffProps {
  readonly environments: readonly Environment[];
  readonly leftId: string;
  readonly rightId: string;
  readonly onSelect: (side: 'left' | 'right', environmentId: string) => void;
  readonly onClose: () => void;
}

type CellState = 'present' | 'absent' | 'not-permitted' | 'unknown';

interface Cell {
  readonly state: CellState;
  /** Version or health detail, when the machine had one to give. */
  readonly detail?: string;
}

interface DiffRow {
  readonly key: string;
  readonly group: 'runtime' | 'agent' | 'shell';
  readonly label: string;
  readonly left: Cell;
  readonly right: Cell;
}

const CELL_CLASS: Record<CellState, string> = {
  present: 'text-primary',
  absent: 'text-on-surface-variant/50',
  'not-permitted': 'text-tertiary',
  unknown: 'text-on-surface-variant/40',
};

/**
 * One environment's answers, or the reason it has none. The queries are
 * disabled outright when the machine does not report its toolchains, so a
 * column that cannot answer costs nothing rather than quietly asking about the
 * hub instead.
 */
function useColumn(environments: readonly Environment[], environmentId: string) {
  const environment = environments.find((candidate) => candidate.id === environmentId);
  const manifest = environment?.status.manifest;
  const permitted = manifest ? manifest.features.probing : true;
  const [runtimes, agents] = useQueries({
    queries: [
      {
        ...runtimeStatusesQueryOptions(environmentId),
        enabled: permitted && environment?.status.state === 'connected',
      },
      {
        ...agentCliStatusesQueryOptions(environmentId),
        enabled: permitted && environment?.status.state === 'connected',
      },
    ],
  });

  const connected = environment?.status.state === 'connected';
  return {
    environment,
    permitted,
    shells: manifest?.shells ?? [],
    runtimes: runtimes?.data ?? [],
    agents: agents?.data ?? [],
    isPending: permitted && connected && Boolean(runtimes?.isPending || agents?.isPending),
  };
}

type Column = ReturnType<typeof useColumn>;

// A cell's `detail` is an optional annotation on `present`, not a label, so an
// unreadable version drops to no detail here rather than to `versionLabel`'s
// wording — the cell already says "present" on its own.
function runtimeCell(column: Column, id: string): Cell {
  if (!column.permitted) return { state: 'not-permitted' };
  const status = column.runtimes.find((entry: RuntimeStatus) => entry.id === id);
  if (!status) return { state: 'unknown' };
  return status.effective
    ? { state: 'present', detail: status.effective.version ?? undefined }
    : { state: 'absent' };
}

function agentCell(column: Column, targetId: string): Cell {
  if (!column.permitted) return { state: 'not-permitted' };
  const status = column.agents.find((entry: AgentCliStatus) => entry.targetId === targetId);
  if (!status) return { state: 'unknown' };
  return status.effective
    ? { state: 'present', detail: status.effective.version ?? undefined }
    : { state: 'absent' };
}

function shellCell(column: Column, shell: string): Cell {
  // Shells come from the handshake, not from a probe, so a machine that will
  // not report its toolchains still answers this one honestly.
  if (!column.environment?.status.manifest) return { state: 'unknown' };
  return column.shells.includes(shell as never) ? { state: 'present' } : { state: 'absent' };
}

export function CapabilityDiff({
  environments,
  leftId,
  rightId,
  onSelect,
  onClose,
}: CapabilityDiffProps) {
  const { t } = useI18n();
  const e = t.environments;
  const { resolve } = useToolIdentities();
  const left = useColumn(environments, leftId);
  const right = useColumn(environments, rightId);

  const runtimeIds = unique([
    ...left.runtimes.map((status) => status.id),
    ...right.runtimes.map((status) => status.id),
  ]);
  const agentIds = unique([
    ...left.agents.map((status) => status.targetId),
    ...right.agents.map((status) => status.targetId),
  ]);
  const shells = unique([...left.shells, ...right.shells]);

  const rows: DiffRow[] = [
    ...runtimeIds.map((id) => ({
      key: `runtime:${id}`,
      group: 'runtime' as const,
      label: resolve('runtime', id).name,
      left: runtimeCell(left, id),
      right: runtimeCell(right, id),
    })),
    ...agentIds.map((id) => ({
      key: `agent:${id}`,
      group: 'agent' as const,
      label: resolve('agent', id).name,
      left: agentCell(left, id),
      right: agentCell(right, id),
    })),
    ...shells.map((shell) => ({
      key: `shell:${shell}`,
      group: 'shell' as const,
      label: shell,
      left: shellCell(left, shell),
      right: shellCell(right, shell),
    })),
  ];

  return (
    <section
      className="space-y-3 rounded-2xl border border-outline-variant/15 bg-surface-container-high p-4"
      data-testid="capability-diff"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="font-headline text-base font-semibold text-on-surface">
            {e.scope.compareTitle}
          </h2>
          <p className="text-sm text-on-surface-variant/60">{e.scope.compareHint}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={e.scope.compareClose}
          className="rounded-lg p-1 text-on-surface-variant/60 transition-colors hover:bg-surface-container-highest hover:text-on-surface"
        >
          <X size={16} />
        </button>
      </div>

      {left.isPending || right.isPending ? (
        <EnvironmentPageState variant="loading" size="section" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-outline-variant/15 text-left">
                <th className="py-2 pr-4 font-label text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/60">
                  {e.tabs.health}
                </th>
                <ColumnHeader
                  label={e.scope.compareLeft}
                  environments={environments}
                  value={leftId}
                  onSelect={(id) => onSelect('left', id)}
                />
                <ColumnHeader
                  label={e.scope.compareRight}
                  environments={environments}
                  value={rightId}
                  onSelect={(id) => onSelect('right', id)}
                />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr
                  key={row.key}
                  className="border-b border-outline-variant/10 last:border-b-0"
                  data-testid="capability-diff-row"
                  data-row-key={row.key}
                >
                  <th scope="row" className="py-2 pr-4 text-left font-medium text-on-surface">
                    {isGroupStart(rows, index) && (
                      <span className="mb-1 block font-label text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/50">
                        {groupLabel(e.scope, row.group)}
                      </span>
                    )}
                    {row.label}
                  </th>
                  <DiffCell cell={row.left} />
                  <DiffCell cell={row.right} />
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && (
            <EnvironmentPageState variant="empty" size="section" title={e.health.empty} />
          )}
        </div>
      )}
    </section>
  );
}

function ColumnHeader({
  label,
  environments,
  value,
  onSelect,
}: {
  readonly label: string;
  readonly environments: readonly Environment[];
  readonly value: string;
  readonly onSelect: (environmentId: string) => void;
}) {
  return (
    <th scope="col" className="py-2 pr-4 text-left">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        aria-label={label}
        onChange={(event) => onSelect(event.target.value)}
        className="max-w-[10rem] appearance-none rounded-lg bg-transparent py-1 text-sm font-semibold text-on-surface outline-none"
      >
        {environments.map((environment) => (
          <option key={environment.id} value={environment.id}>
            {environment.name}
          </option>
        ))}
      </select>
    </th>
  );
}

function DiffCell({ cell }: { readonly cell: Cell }) {
  const { t } = useI18n();
  const scope = t.environments.scope;
  const label = {
    present: scope.cellPresent,
    absent: scope.cellAbsent,
    'not-permitted': scope.cellNotPermitted,
    unknown: scope.cellUnknown,
  }[cell.state];

  return (
    <td className="py-2 pr-4 align-top" data-testid="capability-diff-cell" data-state={cell.state}>
      <span className={CELL_CLASS[cell.state]}>{cell.detail ?? label}</span>
      {cell.detail && <span className="sr-only"> {label}</span>}
    </td>
  );
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function isGroupStart(rows: readonly DiffRow[], index: number): boolean {
  return index === 0 || rows[index - 1]?.group !== rows[index]?.group;
}

function groupLabel(
  scope: { rowGroupRuntime: string; rowGroupAgent: string; rowGroupShell: string },
  group: DiffRow['group']
): string {
  if (group === 'runtime') return scope.rowGroupRuntime;
  return group === 'agent' ? scope.rowGroupAgent : scope.rowGroupShell;
}
