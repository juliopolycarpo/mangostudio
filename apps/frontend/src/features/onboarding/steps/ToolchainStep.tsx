/**
 * Whether the machine can run what an agent asks it to run.
 *
 * Reads the same runtime probe the environment manager draws and offers the
 * same install button, rather than linking there: the whole application is
 * behind the setup gate while setup is unfinished, so a link out of the flow
 * would bounce straight back to it. The install itself — consent, confirmation,
 * the streamed console — is `InstallAction`'s, unchanged.
 */

import { useQueries } from '@tanstack/react-query';
import { CircleAlert, CircleCheck } from 'lucide-react';
import { Callout } from '@/components/ui/Callout';
import { Spinner } from '@/components/ui/Spinner';
import { RecipeAction } from '@/features/environments/components/RecipeAction';
import { installStep } from '@/features/environments/format';
import { useToolIdentities } from '@/features/environments/identity/use-tool-identities';
import {
  installRecipesQueryOptions,
  runtimeStatusesQueryOptions,
} from '@/features/environments/queries';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD } from '@/lib/icon-sizes';
import { StepFrame } from '../StepFrame';
import { isRuntimeReady, PROJECT_RUNTIME_IDS } from '../use-onboarding-facts';

export function ToolchainStep({ environmentId }: { readonly environmentId: string }) {
  const { t } = useI18n();
  const s = t.onboarding.toolchain;
  const { resolve } = useToolIdentities();
  const [runtimes, recipes] = useQueries({
    queries: [
      runtimeStatusesQueryOptions(environmentId),
      installRecipesQueryOptions(environmentId),
    ],
  });

  return (
    <StepFrame title={s.title} lead={s.lead} hint={s.hint}>
      {runtimes.isPending ? (
        <div className="flex justify-center py-6">
          <Spinner size="md" />
        </div>
      ) : runtimes.isError ? (
        // A refused probe answers `[]`, exactly like a machine with neither
        // runtime on it. Drawing the list from that tells somebody who has Node
        // installed to install Node, and offers a button that would do it.
        <Callout tone="warning" data-testid="onboarding-toolchain-failed">
          {s.probeFailed}
        </Callout>
      ) : (
        <ul className="divide-y divide-stroke border-y border-stroke">
          {PROJECT_RUNTIME_IDS.map((id) => {
            const runtime = (runtimes.data ?? []).find((candidate) => candidate.id === id);
            const ready = isRuntimeReady(runtime);
            const name = resolve('runtime', id).name;
            return (
              <li
                key={id}
                data-testid={`onboarding-runtime-${id}`}
                data-ready={ready}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <span className="flex items-center gap-2">
                  {ready ? (
                    <CircleCheck aria-hidden size={ICON_MD} className="shrink-0 text-success" />
                  ) : (
                    <CircleAlert aria-hidden size={ICON_MD} className="shrink-0 text-fg-subtle" />
                  )}
                  <span className="text-sm font-medium text-fg">{name}</span>
                </span>
                {ready ? (
                  <span className="text-xs text-fg-muted">
                    {runtime?.effective?.version ?? s.ready}
                  </span>
                ) : (
                  <span className="flex items-center gap-3">
                    <span className="text-xs text-fg-muted">{s.missing}</span>
                    <RecipeAction
                      step={installStep(recipes.data ?? [], id)}
                      action="install"
                      catalog={recipes.data ?? []}
                      name={name}
                      environmentId={environmentId}
                    />
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </StepFrame>
  );
}
