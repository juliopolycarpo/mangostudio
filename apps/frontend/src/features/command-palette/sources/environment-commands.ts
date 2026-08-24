/**
 * One row per execution environment, jumping to the umbrella scoped to it.
 *
 * The scope lives in the URL (`?environmentId=`), so these are ordinary links
 * rather than a selection the palette has to reach into another component to
 * make.
 */

import type { Environment } from '@mangostudio/shared/environments';
import type { Messages } from '@mangostudio/shared/i18n';
import { MonitorCog } from 'lucide-react';
import type { CommandItem } from '@/features/command-palette/lib/command-item';

export interface EnvironmentCommandParams {
  readonly environments: readonly Environment[];
  readonly t: Messages;
  readonly onSelect: (environmentId: string) => void;
}

export function environmentCommands({
  environments,
  t,
  onSelect,
}: EnvironmentCommandParams): CommandItem[] {
  const labels = t.environments.entities;
  return environments.map((environment) => ({
    id: `environment:${environment.id}`,
    section: 'environments' as const,
    label: environment.name,
    hint: labels.transport[environment.transportKind],
    meta: labels.status[environment.status.state],
    // The built-in machine is reached by `local` far more often than by its
    // display name, and a disabled row is worth finding by that word too.
    keywords: [environment.id, environment.enabled ? '' : labels.disabled].join('\n'),
    icon: MonitorCog,
    run: () => onSelect(environment.id),
  }));
}
