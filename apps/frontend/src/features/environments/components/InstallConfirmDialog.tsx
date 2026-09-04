/**
 * Shown before anything runs: the exact argv, what it writes, whether it needs
 * the network, and — for a downloaded installer — where the script came from and
 * how many bytes were fetched.
 *
 * A prerequisite chain is one decision, so it is one dialog: every step is laid
 * out in the order it will run, and confirming runs all of them. Only the first
 * step has been prepared against the server, so only it can carry a downloaded
 * installer's real size and digest; the rest are shown from the catalog preview,
 * which is what the server will re-derive when its turn comes.
 */

import type { InstallPreparation, InstallRecipePreview } from '@mangostudio/shared/environments';
import { renderShellCommand } from '@mangostudio/shared/environments';
import { Download, FolderPen, Globe, TerminalSquare, X } from 'lucide-react';
import { useEffect } from 'react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { chainStepLabel, formatBytes } from '../format';
import { useToolIdentities } from '../identity/use-tool-identities';
import type { InstallChainStep } from '../install-chain';

interface InstallConfirmDialogProps {
  preparation: InstallPreparation;
  /** The whole chain, in run order. A lone step is the ordinary single install. */
  steps: readonly InstallChainStep[];
  isStarting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function InstallConfirmDialog({
  preparation,
  steps,
  isStarting,
  onConfirm,
  onCancel,
}: InstallConfirmDialogProps) {
  const { t } = useI18n();
  const s = t.environments.install;
  const { resolve } = useToolIdentities();

  // Escape backs out of the dialog, as it does everywhere else in the app. A
  // modal that gates running a command must not trap a keyboard user in it.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  // The prepared recipe is the authority on the step it describes: it alone
  // knows the installer that was actually downloaded.
  const recipes: readonly InstallRecipePreview[] = steps.map((step, index) =>
    index === 0 ? preparation.recipe : step.recipe
  );
  const isChain = recipes.length > 1;
  // Uninstall is never a chain — nothing on offer removes a prerequisite —
  // so a single step whose action is `uninstall` is the whole signal.
  const primaryRecipe = !isChain ? recipes[0] : undefined;
  const isUninstall = primaryRecipe?.action === 'uninstall';
  const title =
    isUninstall && primaryRecipe
      ? formatMessage(s.confirmUninstallTitle, {
          target: resolve('runtime', primaryRecipe.runtimeId).name,
        })
      : s.confirmTitle;
  const description = isChain
    ? formatMessage(s.chainDescription, { count: String(recipes.length) })
    : isUninstall && primaryRecipe
      ? formatMessage(s.confirmUninstallDescription, { paths: primaryRecipe.writes.join(', ') })
      : s.confirmDescription;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-3 backdrop-blur-sm sm:p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="install-confirm-title"
        className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-3xl border border-outline-variant/20 bg-surface-container-high shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-outline-variant/15 px-5 py-4 sm:px-6">
          <div className="min-w-0 space-y-1">
            <h2 id="install-confirm-title" className="text-xl font-bold text-on-surface">
              {title}
            </h2>
            <p className="text-sm text-on-surface-variant/65">{description}</p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl p-2 text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-on-surface"
            aria-label={s.cancel}
          >
            <X size={18} />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4 sm:px-6">
          {recipes.map((recipe, index) => (
            <div
              key={recipe.id}
              className={
                isChain ? 'space-y-5 rounded-2xl border border-outline-variant/15 p-4' : 'space-y-5'
              }
              data-testid="install-step"
            >
              {isChain && (
                <p className="font-label text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70">
                  {chainStepLabel(
                    t,
                    index,
                    recipes.length,
                    resolve('runtime', recipe.runtimeId).name
                  )}
                </p>
              )}
              <RecipeDetails recipe={recipe} />
            </div>
          ))}
        </div>

        <footer className="flex justify-end gap-2 border-t border-outline-variant/15 px-5 py-4 sm:px-6">
          <Button variant="ghost" onClick={onCancel}>
            {s.cancel}
          </Button>
          <Button onClick={onConfirm} loading={isStarting}>
            {isUninstall ? s.runUninstall : s.run}
          </Button>
        </footer>
      </div>
    </div>
  );
}

function RecipeDetails({ recipe }: { recipe: InstallRecipePreview }) {
  const { t } = useI18n();
  const s = t.environments.install;

  return (
    <>
      <section className="space-y-2">
        <SectionLabel icon={<TerminalSquare size={14} />} label={s.commandLabel} />
        <code
          className="block break-all rounded-xl bg-surface-container-highest px-3 py-2 font-mono text-xs text-on-surface"
          data-testid="install-argv"
        >
          {/* Quoted the way the API quotes its copyable command: an
              argument containing whitespace must not read as two. */}
          {renderShellCommand(recipe.argv)}
        </code>
      </section>

      {recipe.writes.length > 0 && (
        <section className="space-y-2">
          <SectionLabel icon={<FolderPen size={14} />} label={s.willWrite} />
          <ul className="space-y-1">
            {recipe.writes.map((target) => (
              <li key={target} className="break-all font-mono text-xs text-on-surface-variant">
                {target}
              </li>
            ))}
          </ul>
        </section>
      )}

      {recipe.networkAccess && (
        <section className="flex items-center gap-2 text-sm text-on-surface-variant">
          <Globe size={14} className="shrink-0 text-tertiary" />
          <span>{s.requiresNetwork}</span>
        </section>
      )}

      {recipe.download && (
        <section className="space-y-1.5">
          <SectionLabel icon={<Download size={14} />} label={s.downloadLabel} />
          <p className="break-all font-mono text-xs text-on-surface-variant">
            {formatMessage(s.downloadOrigin, { url: recipe.download.url })}
          </p>
          {recipe.download.sizeBytes !== undefined && (
            <p className="text-xs text-on-surface-variant/70">
              {formatMessage(s.downloadSize, {
                size: formatBytes(recipe.download.sizeBytes),
              })}
            </p>
          )}
        </section>
      )}

      {recipe.profileSetup && (
        <section className="space-y-2">
          <p className="text-sm text-on-surface-variant">{s.profileSetup}</p>
          <code className="block whitespace-pre-wrap break-all rounded-xl bg-surface-container-highest px-3 py-2 font-mono text-xs text-on-surface">
            {recipe.profileSetup.lines.join('\n')}
          </code>
          {recipe.profileSetup.present && (
            <p className="text-xs text-on-surface-variant/70">
              {formatMessage(s.profileAlreadyPresent, {
                files: recipe.profileSetup.detectedIn.join(', '),
              })}
            </p>
          )}
        </section>
      )}
    </>
  );
}

function SectionLabel({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2 text-on-surface-variant/70">
      {icon}
      <span className="font-label text-[10px] font-bold uppercase tracking-widest">{label}</span>
    </div>
  );
}
