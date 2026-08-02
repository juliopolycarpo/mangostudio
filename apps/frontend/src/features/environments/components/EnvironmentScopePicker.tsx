/**
 * Which machine a diagnostic tab is describing.
 *
 * Distinct from the chat's environment selector: that one binds a conversation
 * to where its tools run, this one only changes what you are looking at. It
 * hides itself when there is nothing to choose between, so a single-machine
 * install reads exactly as it did before environments existed.
 */

import type { Environment } from '@mangostudio/shared/environments';
import { Server } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';

interface EnvironmentScopePickerProps {
  readonly environmentId: string;
  readonly environments: readonly Environment[];
  readonly onSelect: (environmentId: string) => void;
}

export function EnvironmentScopePicker({
  environmentId,
  environments,
  onSelect,
}: EnvironmentScopePickerProps) {
  const { t } = useI18n();
  const e = t.environments;

  return (
    <label
      className="flex h-8 items-center gap-2 rounded-full border border-outline-variant/20 bg-surface-container-lowest pl-3 text-xs font-medium text-on-surface-variant transition-colors hover:border-primary/30 hover:text-on-surface"
      data-testid="environment-scope-picker"
      data-environment-id={environmentId}
    >
      <Server size={13} className="shrink-0 text-primary/80" aria-hidden="true" />
      <span className="sr-only">{e.scope.label}</span>
      <select
        value={environmentId}
        onChange={(event) => onSelect(event.target.value)}
        aria-label={e.scope.label}
        className="min-w-0 max-w-[11rem] appearance-none bg-transparent py-1 pr-3 text-inherit outline-none"
      >
        {environments.map((environment) => (
          <option key={environment.id} value={environment.id} disabled={!environment.enabled}>
            {environment.name}
          </option>
        ))}
      </select>
    </label>
  );
}
