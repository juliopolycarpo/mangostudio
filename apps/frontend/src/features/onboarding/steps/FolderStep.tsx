/**
 * Which machine, and which folder on it.
 *
 * The machine is chosen first and persisted before the picker opens, because
 * every later step — toolchain, agents, the first chat — asks its question
 * about that machine, and browsing one while configuring another is the
 * confusion this ordering exists to prevent.
 */

import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments/values';
import type { OnboardingState } from '@mangostudio/shared/onboarding';
import { FolderOpen } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { useEnvironmentEntitiesQuery } from '@/features/environments/queries';
import { WorkdirPickerDialog } from '@/features/workspace/WorkdirPickerDialog';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD } from '@/lib/icon-sizes';

import { StepFrame } from '../StepFrame';

interface FolderStepProps {
  readonly state: OnboardingState;
  readonly onChange: (updater: (current: OnboardingState) => OnboardingState) => Promise<void>;
  /** A write is already open; a second choice would be built on the record it replaces. */
  readonly isSaving: boolean;
}

export function FolderStep({ state, onChange, isSaving }: FolderStepProps) {
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
        <div className="space-y-1">
          <label htmlFor="onboarding-environment" className="text-sm font-medium text-fg">
            {s.machineLabel}
          </label>
          <Select
            id="onboarding-environment"
            testId="onboarding-environment"
            disabled={isSaving}
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
          <p className="text-xs text-fg-muted">{s.machineHint}</p>
        </div>
      ) : null}

      {/* The path reads the way a command does everywhere else in setup: mono
          on `canvas`, one step off the card it sits in. */}
      {state.workdir ? (
        <div className="space-y-1">
          <p className="text-xs text-fg-muted">{s.selected}</p>
          <code
            data-testid="onboarding-workdir"
            className="block break-all rounded-md border border-stroke bg-canvas px-3 py-2 font-mono text-xs text-fg"
          >
            {state.workdir}
          </code>
        </div>
      ) : (
        <p className="text-sm text-fg-muted">{s.empty}</p>
      )}

      <Button
        variant={state.workdir ? 'secondary' : 'primary'}
        data-testid="onboarding-choose-folder"
        disabled={isSaving}
        onClick={() => setPickerOpen(true)}
      >
        <FolderOpen aria-hidden size={ICON_MD} />
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
