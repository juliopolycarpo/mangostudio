import type { AgentProfile } from '@mangostudio/shared/agents';

interface AgentListProps {
  readonly agents: ReadonlyArray<AgentProfile>;
  readonly selectedAgentId: string | null;
  readonly builtInLabel: string;
  readonly userLabel: string;
  readonly onSelect: (agentId: string) => void;
}

export function AgentList({
  agents,
  selectedAgentId,
  builtInLabel,
  userLabel,
  onSelect,
}: AgentListProps) {
  return (
    <div className="space-y-2">
      {agents.map((agent) => {
        const active = agent.id === selectedAgentId;
        const kindLabel = agent.kind === 'builtin' ? builtInLabel : userLabel;
        return (
          <button
            key={agent.id}
            type="button"
            onClick={() => onSelect(agent.id)}
            className={`w-full rounded-2xl border px-4 py-3 text-left transition-colors ${
              active
                ? 'border-primary/40 bg-primary/10 text-on-surface'
                : 'border-outline-variant/20 bg-surface-container-high text-on-surface hover:bg-surface-container-highest'
            }`}
          >
            <span className="flex items-center justify-between gap-3">
              <span className="font-semibold">{agent.name}</span>
              <span className="rounded-full bg-surface-container-lowest px-2 py-0.5 text-xs text-on-surface-variant">
                {kindLabel}
              </span>
            </span>
            <span className="mt-1 block truncate text-sm text-on-surface-variant/70">
              {agent.description || agent.id}
            </span>
          </button>
        );
      })}
    </div>
  );
}
