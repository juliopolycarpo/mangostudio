/**
 * Shown before anything runs: the exact argv, what it writes, whether it needs
 * the network, and — for a downloaded installer — where the script came from and
 * how many bytes were fetched.
 */

import type { InstallPreparation } from '@mangostudio/shared/environments';
import { Download, FolderPen, Globe, TerminalSquare, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { formatBytes, formatMessage } from '../format';

interface InstallConfirmDialogProps {
  preparation: InstallPreparation;
  isStarting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function InstallConfirmDialog({
  preparation,
  isStarting,
  onConfirm,
  onCancel,
}: InstallConfirmDialogProps) {
  const { t } = useI18n();
  const s = t.environments.install;
  const { recipe } = preparation;

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
              {s.confirmTitle}
            </h2>
            <p className="text-sm text-on-surface-variant/65">{s.confirmDescription}</p>
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
          <section className="space-y-2">
            <SectionLabel icon={<TerminalSquare size={14} />} label={s.commandLabel} />
            <code
              className="block break-all rounded-xl bg-surface-container-highest px-3 py-2 font-mono text-xs text-on-surface"
              data-testid="install-argv"
            >
              {recipe.argv.join(' ')}
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
        </div>

        <footer className="flex justify-end gap-2 border-t border-outline-variant/15 px-5 py-4 sm:px-6">
          <Button variant="ghost" onClick={onCancel}>
            {s.cancel}
          </Button>
          <Button onClick={onConfirm} loading={isStarting}>
            {s.run}
          </Button>
        </footer>
      </div>
    </div>
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
