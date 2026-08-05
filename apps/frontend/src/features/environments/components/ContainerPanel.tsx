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
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { resolveApiErrorMessage } from '@/lib/utils';
import {
  type ContainerFormFields,
  containerConfigToForm,
  containerFormToConfig,
  validateContainerForm,
} from '../container-form';
import { useUpdateEnvironmentMutation } from '../queries';
import { ContainerConfigFields } from './ContainerConfigFields';

interface ContainerPanelProps {
  readonly environment: Environment;
}

export function ContainerPanel({ environment }: ContainerPanelProps) {
  const { t } = useI18n();
  const labels = t.environments.entities.container;
  const update = useUpdateEnvironmentMutation();
  const stored = containerConfigToForm(environment.config);
  const [form, setForm] = useState<ContainerFormFields>(stored);
  const [edited, setEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Realtime keeps environment rows fresh; an untouched form follows them, and
  // one someone is typing into does not get overwritten mid-edit.
  const storedKey = JSON.stringify(stored);
  useEffect(() => {
    if (!edited) setForm(JSON.parse(storedKey) as ContainerFormFields);
  }, [edited, storedKey]);

  const invalid = validateContainerForm(form);
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
    <section
      className="space-y-3 rounded-xl border border-outline-variant/20 bg-surface-container-lowest/60 p-3"
      data-testid="container-panel"
    >
      <div className="flex items-start gap-2">
        <Box size={14} className="mt-0.5 shrink-0 text-primary" />
        <div className="min-w-0 space-y-0.5">
          <p className="font-semibold text-on-surface text-xs">{labels.title}</p>
          <p className="text-[11px] text-on-surface-variant/70">{labels.description}</p>
        </div>
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-primary/35 bg-primary/5 px-2.5 py-2">
        <ShieldCheck size={13} className="mt-0.5 shrink-0 text-primary" />
        <p className="text-[11px] text-on-surface-variant">{labels.isolationNote}</p>
      </div>

      <p className="text-[11px] text-on-surface-variant/70">{labels.ephemeralNote}</p>

      {environment.status.containerFailureReason ? (
        <p
          className="rounded-lg border border-warning/35 bg-warning/5 px-2.5 py-2 text-[11px] text-on-surface-variant"
          data-testid="container-failure-reason"
        >
          {labels.reason[environment.status.containerFailureReason]}
        </p>
      ) : null}

      <ContainerConfigFields
        idPrefix={`container-${environment.id}`}
        form={form}
        error={invalid}
        onChange={(patch) => {
          setEdited(true);
          setForm((current) => ({ ...current, ...patch }));
        }}
      />

      {error ? (
        <p className="text-[11px] text-error" role="alert">
          {error}
        </p>
      ) : null}

      <Button
        variant="secondary"
        className="h-8 px-2.5 text-xs"
        disabled={!changed || invalid !== null}
        loading={update.isPending}
        onClick={() => void save()}
      >
        {labels.save}
      </Button>
    </section>
  );
}
