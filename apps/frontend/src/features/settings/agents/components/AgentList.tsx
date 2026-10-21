import type { AgentProfile } from '@mangostudio/shared/agents';
import { Bot, User } from 'lucide-react';
import { PickOneRow } from '@/components/settings/PickOneRow';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { ICON_MD } from '@/lib/icon-sizes';

interface AgentListProps {
  readonly agents: ReadonlyArray<AgentProfile>;
  readonly selectedAgentId: string | null;
  /** Names the choice for a screen reader: the rows alone do not say what they pick between. */
  readonly ariaLabel: string;
  readonly builtInAgentsTitle: string;
  readonly userAgentsTitle: string;
  readonly onSelect: (agentId: string) => void;
}

export function AgentList({
  agents,
  selectedAgentId,
  ariaLabel,
  builtInAgentsTitle,
  userAgentsTitle,
  onSelect,
}: AgentListProps) {
  const groups = [
    { title: builtInAgentsTitle, agents: agents.filter((agent) => agent.kind === 'builtin') },
    { title: userAgentsTitle, agents: agents.filter((agent) => agent.kind === 'user') },
  ];

  return (
    <div role="radiogroup" aria-label={ariaLabel} className="space-y-6">
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
 * row carries only what tells two of them apart.
 */
function AgentListItem({ agent, active, onSelect }: AgentListItemProps) {
  const Icon = agent.kind === 'builtin' ? Bot : User;

  return (
    <PickOneRow
      name="settings-agent"
      checked={active}
      onSelect={onSelect}
      icon={<Icon size={ICON_MD} />}
      title={agent.name}
      description={agent.description || agent.id}
      onCanvas
    />
  );
}
