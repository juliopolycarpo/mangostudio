/**
 * Which machine, and which folder on it.
 *
 * The machine is chosen first and persisted before the picker opens, because
 * every later step — toolchain, agents, the first chat — asks its question
 * about that machine, and browsing one while configuring another is the
 * confusion this ordering exists to prevent.
 */

import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import type { OnboardingState } from '@mangostudio/shared/onboarding';
import { FolderOpen } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { useEnvironmentEntitiesQuery } from '@/features/environments/queries';
import { WorkdirPickerDialog } from '@/features/workspace/WorkdirPickerDialog';
import { useI18n } from '@/hooks/use-i18n';
import { StepFrame } from '../StepFrame';

interface FolderStepProps {
  readonly state: OnboardingState;
  readonly onChange: (updater: (current: OnboardingState) => OnboardingState) => Promise<void>;
}

export function FolderStep({ state, onChange }: FolderStepProps) {
  const { t } = useI18n();
  const s = t.onboarding.folder;
  const [isPickerOpen, setPickerOpen] = useState(false);
  const environments = useEnvironmentEntitiesQuery();
  const environmentId = state.environmentId ?? LOCAL_ENVIRONMENT_ID;
  const options = (environments.data ?? []).map((environment) => ({
    value: environment.id,
    label: environment.name,
  }));

  return (
    <StepFrame title={s.title} lead={s.lead} hint={s.hint}>
      {/* Only worth a control when there is a choice to make; one machine is
          the overwhelmingly common case and a locked dropdown is noise. */}
      {options.length > 1 ? (
        <div className="space-y-1.5">
          <label
            htmlFor="onboarding-environment"
            className="font-label font-semibold text-on-surface-variant text-xs uppercase tracking-wider"
          >
            {s.machineLabel}
          </label>
          <Select
            id="onboarding-environment"
            testId="onboarding-environment"
            value={environmentId}
            options={options}
            onChange={(next) =>
              // Persisted before the picker can open: the browse request needs
              // this id, and a folder chosen against the wrong machine would be
              // a path that does not exist on the one the chat runs on.
              void onChange((current) => ({
                ...current,
                environmentId: next,
                ...(current.workdir === undefined ? {} : { workdir: undefined }),
              }))
            }
          />
          <p className="text-on-surface-variant/60 text-xs">{s.machineHint}</p>
        </div>
      ) : null}

      <div className="rounded-2xl border border-outline-variant/20 bg-surface-container-lowest/60 p-4">
        {state.workdir ? (
          <div className="space-y-1">
            <p className="font-label text-[10px] text-on-surface-variant/70 uppercase tracking-widest">
              {s.selected}
            </p>
            <code
              data-testid="onboarding-workdir"
              className="block break-all font-mono text-on-surface text-xs"
            >
              {state.workdir}
            </code>
          </div>
        ) : (
          <p className="text-on-surface-variant/70 text-sm">{s.empty}</p>
        )}
      </div>

      <Button
        variant={state.workdir ? 'secondary' : 'primary'}
        data-testid="onboarding-choose-folder"
        onClick={() => setPickerOpen(true)}
      >
        <FolderOpen aria-hidden size={15} />
        {state.workdir ? s.change : s.choose}
      </Button>

      <WorkdirPickerDialog
        open={isPickerOpen}
        environmentId={environmentId}
        initialPath={state.workdir ?? null}
        showUseDefault={false}
        onSelect={async (path) => {
          await onChange((current) => ({ ...current, workdir: path }));
          setPickerOpen(false);
        }}
        onClose={() => setPickerOpen(false)}
      />
    </StepFrame>
  );
}
