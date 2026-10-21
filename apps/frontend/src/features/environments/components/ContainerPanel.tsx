/**
 * The container half of an environment card: what it runs in, what it can
 * reach, and — when a launch failed — which of the several unrelated causes it
 * was.
 *
 * It also says which direction the isolation points, because that is the part
 * users get wrong. A container constrains the *agent*: it keeps a tool call off
 * the rest of the machine. It is not a boundary against whoever configured the
 * environment, since the engine runs as the hub's own user and is
 * host-root-equivalent.
 */

import type { Environment } from '@mangostudio/shared/environments';
import { Box, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD } from '@/lib/icon-sizes';
import { resolveApiErrorMessage } from '@/lib/utils';
import {
  type ContainerFormFields,
  containerConfigToForm,
  containerFormToConfig,
  validateContainerForm,
} from '../container-form';
import { useUpdateEnvironmentMutation } from '../queries';
import { ContainerConfigFields } from './ContainerConfigFields';
import { EntityPanel } from './EntityPanel';

interface ContainerPanelProps {
  readonly environment: Environment;
}

export function ContainerPanel({ environment }: ContainerPanelProps) {
  const { t } = useI18n();
  const labels = t.environments.entities.container;
  const update = useUpdateEnvironmentMutation();
  const stored = useMemo(() => containerConfigToForm(environment.config), [environment.config]);
  const [form, setForm] = useState<ContainerFormFields>(stored);
  const [edited, setEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Realtime keeps environment rows fresh; an untouched form follows them, and
  // one someone is typing into does not get overwritten mid-edit. Keyed on the
  // row itself rather than a serialization of it: the effect only has to run
  // when the stored config actually changes identity, which is what the memo
  // above tracks.
  useEffect(() => {
    if (!edited) setForm(stored);
  }, [edited, stored]);

  const errors = validateContainerForm(form);
  const invalid = errors.length > 0;
  const config = containerFormToConfig(form);
  const changed = JSON.stringify(config) !== JSON.stringify(containerFormToConfig(stored));

  const save = async (): Promise<void> => {
    if (!changed || invalid) return;
    setError(null);
    try {
      await update.mutateAsync({ id: environment.id, updates: { config } });
      setEdited(false);
    } catch (caught) {
      setError(resolveApiErrorMessage(caught, labels.saveFailed));
    }
  };

  return (
    <EntityPanel
      testId="container-panel"
      icon={<Box size={ICON_MD} />}
      title={labels.title}
      description={labels.description}
    >
      <Callout tone="info" icon={<ShieldCheck size={ICON_MD} />}>
        {labels.isolationNote}
      </Callout>

      <p className="text-xs text-fg-muted">{labels.ephemeralNote}</p>

      {environment.status.containerFailureReason ? (
        <Callout tone="warning" data-testid="container-failure-reason">
          {labels.reason[environment.status.containerFailureReason]}
        </Callout>
      ) : null}

      <ContainerConfigFields
        idPrefix={`container-${environment.id}`}
        form={form}
        errors={errors}
        onChange={(patch) => {
          setEdited(true);
          setForm((current) => ({ ...current, ...patch }));
        }}
      />

      {error ? (
        <Callout tone="danger" role="alert">
          {error}
        </Callout>
      ) : null}

      <Button
        variant="secondary"
        disabled={!changed || invalid}
        loading={update.isPending}
        onClick={() => void save()}
      >
        {labels.save}
      </Button>
    </EntityPanel>
  );
}
