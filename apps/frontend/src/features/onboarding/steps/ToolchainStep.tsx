/**
 * Whether the machine can run what an agent asks it to run.
 *
 * Reads the same runtime probe the environment manager draws and offers the
 * same install button, rather than linking there: the whole application is
 * behind the setup gate while setup is unfinished, so a link out of the flow
 * would bounce straight back to it. The install itself — consent, confirmation,
 * the streamed console — is `InstallAction`'s, unchanged.
 */

import type { RuntimeStatus } from '@mangostudio/shared/environments';
import { useQueries } from '@tanstack/react-query';
import { CircleAlert, CircleCheck } from 'lucide-react';
import { Spinner } from '@/components/ui/Spinner';
import { RecipeAction } from '@/features/environments/components/RecipeAction';
import { installStep } from '@/features/environments/format';
import { useToolIdentities } from '@/features/environments/identity/use-tool-identities';
import {
  installRecipesQueryOptions,
  runtimeStatusesQueryOptions,
} from '@/features/environments/queries';
import { useI18n } from '@/hooks/use-i18n';
import { StepFrame } from '../StepFrame';

/** The two runtimes a project's own commands need; either one is enough to work. */
const PROJECT_RUNTIME_IDS = ['node', 'bun'] as const;

function isReady(runtime: RuntimeStatus | undefined): boolean {
  return runtime?.health === 'ok' || runtime?.health === 'warn';
}

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
      ) : (
        <ul className="space-y-2">
          {PROJECT_RUNTIME_IDS.map((id) => {
            const runtime = (runtimes.data ?? []).find((candidate) => candidate.id === id);
            const ready = isReady(runtime);
            const name = resolve('runtime', id).name;
            return (
              <li
                key={id}
                data-testid={`onboarding-runtime-${id}`}
                data-ready={ready}
                className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-outline-variant/20 bg-surface-container-lowest/60 px-4 py-3"
              >
                <span className="flex items-center gap-2.5">
                  {ready ? (
                    <CircleCheck aria-hidden size={16} className="shrink-0 text-primary" />
                  ) : (
                    <CircleAlert
                      aria-hidden
                      size={16}
                      className="shrink-0 text-on-surface-variant/50"
                    />
                  )}
                  <span className="font-semibold text-on-surface text-sm">{name}</span>
                </span>
                {ready ? (
                  <span className="text-on-surface-variant/70 text-xs">
                    {runtime?.effective?.version ?? s.ready}
                  </span>
                ) : (
                  <span className="flex items-center gap-3">
                    <span className="text-on-surface-variant/70 text-xs">{s.missing}</span>
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
