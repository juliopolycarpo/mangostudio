import type { AgentProfile } from '@mangostudio/shared/agents';
import { Bot, User } from 'lucide-react';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { ICON_MD } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';

interface AgentListProps {
  readonly agents: ReadonlyArray<AgentProfile>;
  readonly selectedAgentId: string | null;
  readonly builtInAgentsTitle: string;
  readonly userAgentsTitle: string;
  readonly onSelect: (agentId: string) => void;
}

export function AgentList({
  agents,
  selectedAgentId,
  builtInAgentsTitle,
  userAgentsTitle,
  onSelect,
}: AgentListProps) {
  const groups = [
    { title: builtInAgentsTitle, agents: agents.filter((agent) => agent.kind === 'builtin') },
    { title: userAgentsTitle, agents: agents.filter((agent) => agent.kind === 'user') },
  ];

  return (
    <div className="space-y-6">
      {groups.map((group) =>
        group.agents.length > 0 ? (
          <section key={group.title} className="space-y-2">
            <MicroLabel as="h3" className="block">
              {group.title}
            </MicroLabel>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {group.agents.map((agent) => (
                <AgentListItem
                  key={agent.id}
                  agent={agent}
                  active={agent.id === selectedAgentId}
                  onSelect={() => onSelect(agent.id)}
                />
              ))}
            </div>
          </section>
        ) : null
      )}
    </div>
  );
}

interface AgentListItemProps {
  readonly agent: AgentProfile;
  readonly active: boolean;
  readonly onSelect: () => void;
}

/**
 * The group heading already says whether an agent is built in or yours, so the
 * row carries only what tells two of them apart. The current one is the neutral
 * fill plus the 3px accent bar, as in the navigation.
 */
function AgentListItem({ agent, active, onSelect }: AgentListItemProps) {
  const Icon = agent.kind === 'builtin' ? Bot : User;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        'relative flex w-full cursor-pointer items-center gap-3 rounded-sm border border-stroke px-3 py-2 text-left transition-colors',
        active
          ? 'bg-fill-selected before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-accent'
          : 'bg-surface hover:bg-fill-hover'
      )}
    >
      <Icon size={ICON_MD} className="shrink-0 text-fg-muted" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-sm text-fg', active && 'font-medium')}>
          {agent.name}
        </span>
        <span className="block truncate text-xs text-fg-muted">
          {agent.description || agent.id}
        </span>
      </span>
    </button>
  );
}
