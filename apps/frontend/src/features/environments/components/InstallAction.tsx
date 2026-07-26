/**
 * One install button and everything that follows it: the confirmation dialog,
 * the live console, and the copyable command when the guards refuse.
 *
 * The same button serves all three outcomes, so a blocked install never leaves
 * the user staring at a control that simply does nothing.
 */

import type { InstallRecipePreview, RecipeInput } from '@mangostudio/shared/environments';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { useInstallFlow } from '../hooks/use-install-flow';
import { useInstallStream } from '../hooks/use-install-stream';
import { CopyCommandBlock } from './CopyCommandBlock';
import { InstallConfirmDialog } from './InstallConfirmDialog';
import { InstallConsole } from './InstallConsole';

interface InstallActionProps {
  recipe: InstallRecipePreview | undefined;
  input: RecipeInput;
  label: string;
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md';
  icon?: ReactNode;
}

export function InstallAction({
  recipe,
  input,
  label,
  variant = 'secondary',
  size = 'sm',
  icon,
}: InstallActionProps) {
  const { t } = useI18n();
  const flow = useInstallFlow();
  const runId = flow.state.step === 'running' ? flow.state.runId : null;
  const stream = useInstallStream({
    runId,
    onExit: () => void flow.complete(),
  });

  // A recipe the server never listed cannot be run or explained, so the whole
  // affordance stays out of the way instead of rendering a dead button.
  if (!recipe) return null;

  const isBusy = flow.state.step === 'preparing' || flow.state.step === 'starting';
  const showConsole = flow.state.step === 'running' || flow.state.step === 'finished';

  return (
    <div className="space-y-3">
      {flow.state.step !== 'refused' && !showConsole && (
        <Button
          variant={variant}
          size={size}
          loading={isBusy}
          onClick={() => void flow.begin(recipe, input)}
        >
          {icon}
          {label}
        </Button>
      )}

      {flow.state.step === 'error' && (
        <p className="text-sm text-error">{t.environments.install.startError}</p>
      )}

      {flow.state.step === 'refused' && (
        <CopyCommandBlock recipe={flow.state.recipe} message={flow.state.message} />
      )}

      {(flow.state.step === 'confirming' || flow.state.step === 'starting') && (
        <InstallConfirmDialog
          preparation={flow.state.preparation}
          isStarting={flow.state.step === 'starting'}
          onConfirm={() => void flow.confirm(input)}
          onCancel={flow.dismiss}
        />
      )}

      {showConsole && (
        <InstallConsole
          stream={stream}
          onCancel={() => void flow.cancel()}
          onClose={flow.dismiss}
        />
      )}
    </div>
  );
}
