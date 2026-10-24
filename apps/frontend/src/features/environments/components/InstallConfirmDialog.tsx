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
import { renderShellCommand } from '@mangostudio/shared/environments/values';
import { Download, FolderPen, Globe, TerminalSquare, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_MD, ICON_SM } from '@/lib/icon-sizes';
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
    // Escape and the backdrop back out of the dialog, as they do everywhere
    // else in the app: a modal that gates running a command must not trap a
    // keyboard user in it.
    <Dialog
      size="lg"
      title={title}
      description={description}
      onClose={onCancel}
      headerAction={
        <Button variant="subtle" size="icon" onClick={onCancel} aria-label={s.cancel}>
          <X size={ICON_MD} />
        </Button>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            {s.cancel}
          </Button>
          <Button
            variant={isUninstall ? 'danger' : 'primary'}
            onClick={onConfirm}
            loading={isStarting}
          >
            {isUninstall ? s.runUninstall : s.run}
          </Button>
        </>
      }
    >
      {recipes.map((recipe, index) => (
        <div
          key={recipe.id}
          className={isChain ? 'space-y-5 rounded-md border border-stroke p-4' : 'space-y-5'}
          data-testid="install-step"
        >
          {isChain && (
            <MicroLabel as="p">
              {chainStepLabel(t, index, recipes.length, resolve('runtime', recipe.runtimeId).name)}
            </MicroLabel>
          )}
          <RecipeDetails recipe={recipe} />
        </div>
      ))}
    </Dialog>
  );
}

function RecipeDetails({ recipe }: { recipe: InstallRecipePreview }) {
  const { t } = useI18n();
  const s = t.environments.install;

  return (
    <>
      <section className="space-y-2">
        <SectionLabel icon={<TerminalSquare size={ICON_SM} />} label={s.commandLabel} />
        <code
          className="block break-all rounded-md border border-stroke bg-canvas px-3 py-2 font-mono text-xs text-fg"
          data-testid="install-argv"
        >
          {/* Quoted the way the API quotes its copyable command: an
              argument containing whitespace must not read as two. */}
          {renderShellCommand(recipe.argv)}
        </code>
      </section>

      {recipe.writes.length > 0 && (
        <section className="space-y-2">
          <SectionLabel icon={<FolderPen size={ICON_SM} />} label={s.willWrite} />
          <ul className="space-y-1">
            {recipe.writes.map((target) => (
              <li key={target} className="break-all font-mono text-xs text-fg-muted">
                {target}
              </li>
            ))}
          </ul>
        </section>
      )}

      {recipe.networkAccess && (
        <section className="flex items-center gap-2 text-sm text-fg-muted">
          <Globe size={ICON_SM} className="shrink-0" />
          <span>{s.requiresNetwork}</span>
        </section>
      )}

      {recipe.download && (
        <section className="space-y-1.5">
          <SectionLabel icon={<Download size={ICON_SM} />} label={s.downloadLabel} />
          <p className="break-all font-mono text-xs text-fg-muted">
            {formatMessage(s.downloadOrigin, { url: recipe.download.url })}
          </p>
          {recipe.download.sizeBytes !== undefined && (
            <p className="text-xs text-fg-muted">
              {formatMessage(s.downloadSize, {
                size: formatBytes(recipe.download.sizeBytes),
              })}
            </p>
          )}
        </section>
      )}

      {recipe.profileSetup && (
        <section className="space-y-2">
          <p className="text-sm text-fg-muted">{s.profileSetup}</p>
          <code className="block whitespace-pre-wrap break-all rounded-md border border-stroke bg-canvas px-3 py-2 font-mono text-xs text-fg">
            {recipe.profileSetup.lines.join('\n')}
          </code>
          {recipe.profileSetup.present && (
            <p className="text-xs text-fg-muted">
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
    <MicroLabel as="p" className="flex items-center gap-2">
      {icon}
      {label}
    </MicroLabel>
  );
}
