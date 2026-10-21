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
import { Select } from '@/components/ui/Select';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD } from '@/lib/icon-sizes';

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
    <div
      className="flex items-center gap-2"
      data-testid="environment-scope-picker"
      data-environment-id={environmentId}
    >
      <Server size={ICON_MD} className="shrink-0 text-fg-muted" aria-hidden="true" />
      <Select
        value={environmentId}
        options={environments.map((environment) => ({
          value: environment.id,
          label: environment.name,
          disabled: !environment.enabled,
        }))}
        onChange={onSelect}
        ariaLabel={e.scope.label}
        className="w-48"
      />
    </div>
  );
}
