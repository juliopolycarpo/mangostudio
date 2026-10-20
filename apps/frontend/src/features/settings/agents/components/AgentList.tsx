import type { AgentProfile } from '@mangostudio/shared/agents';
import { Bot, ChevronRight, User } from 'lucide-react';

interface AgentListProps {
  readonly agents: ReadonlyArray<AgentProfile>;
  readonly selectedAgentId: string | null;
  readonly builtInLabel: string;
  readonly userLabel: string;
  readonly builtInAgentsTitle: string;
  readonly userAgentsTitle: string;
  readonly onSelect: (agentId: string) => void;
}

export function AgentList({
  agents,
  selectedAgentId,
  builtInLabel,
  userLabel,
  builtInAgentsTitle,
  userAgentsTitle,
  onSelect,
}: AgentListProps) {
  const builtIn = agents.filter((a) => a.kind === 'builtin');
  const user = agents.filter((a) => a.kind === 'user');

  return (
    <div className="flex flex-col gap-6">
      {builtIn.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-xs uppercase tracking-widest font-bold text-fg-muted px-1">
            {builtInAgentsTitle}
          </h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {builtIn.map((agent) => (
              <AgentListItem
                key={agent.id}
                agent={agent}
                kindLabel={builtInLabel}
                active={agent.id === selectedAgentId}
                onSelect={() => onSelect(agent.id)}
              />
            ))}
          </div>
        </section>
      )}

      {user.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-xs uppercase tracking-widest font-bold text-fg-muted px-1">
            {userAgentsTitle}
          </h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {user.map((agent) => (
              <AgentListItem
                key={agent.id}
                agent={agent}
                kindLabel={userLabel}
                active={agent.id === selectedAgentId}
                onSelect={() => onSelect(agent.id)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

interface AgentListItemProps {
  readonly agent: AgentProfile;
  readonly kindLabel: string;
  readonly active: boolean;
  readonly onSelect: () => void;
}

function AgentListItem({ agent, kindLabel, active, onSelect }: AgentListItemProps) {
  const Icon = agent.kind === 'builtin' ? Bot : User;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`group w-full rounded-2xl border text-left transition-all duration-200 ${
        active
          ? 'border-accent bg-accent-subtle text-fg shadow-sm'
          : 'border-stroke bg-surface text-fg hover:bg-fill-hover hover:border-stroke'
      }`}
    >
      <span className="flex items-center gap-3 px-3 py-2.5">
        <span
          className={`shrink-0 rounded-xl p-1.5 transition-colors ${
            active
              ? 'bg-accent-subtle text-accent-fg'
              : 'bg-control text-fg-muted group-hover:text-fg-muted'
          }`}
        >
          <Icon size={16} />
        </span>
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-2">
            <span className="font-semibold text-sm truncate">{agent.name}</span>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                active ? 'bg-accent-subtle text-accent-fg' : 'bg-control text-fg-muted'
              }`}
            >
              {kindLabel}
            </span>
          </span>
          <span className="block truncate text-xs text-fg-muted mt-0.5">
            {agent.description || agent.id}
          </span>
        </span>
        <ChevronRight
          size={14}
          className={`shrink-0 transition-all duration-200 ${
            active
              ? 'text-accent-fg translate-x-0 opacity-100'
              : 'text-fg-subtle opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0'
          }`}
        />
      </span>
    </button>
  );
}
