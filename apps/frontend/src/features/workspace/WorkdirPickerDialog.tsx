import type { WorkdirValidationReason } from '@mangostudio/shared/workspaces';
import {
  ArrowUp,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  HardDrive,
  Home,
  LoaderCircle,
  Server,
  X,
} from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { resolveApiErrorMessage } from '@/lib/utils';
import { useDirectoryListing, validateWorkspacePath } from './use-directory-listing';

interface WorkdirPickerDialogProps {
  open: boolean;
  initialPath?: string | null;
  defaultWorkdir?: string;
  recentWorkdirs?: ReadonlyArray<string>;
  showUseDefault?: boolean;
  onSelect: (path: string) => void | Promise<void>;
  onClose: () => void;
}

function validationMessage(
  reason: WorkdirValidationReason | undefined,
  messages: {
    notFound: string;
    notDirectory: string;
    permissionDenied: string;
  },
  fallback: string
): string {
  switch (reason) {
    case 'not-found':
      return messages.notFound;
    case 'not-a-directory':
      return messages.notDirectory;
    case 'permission-denied':
      return messages.permissionDenied;
    default:
      return fallback;
  }
}

export function WorkdirPickerDialog({
  open,
  initialPath = null,
  defaultWorkdir = '',
  recentWorkdirs = [],
  showUseDefault = true,
  onSelect,
  onClose,
}: WorkdirPickerDialogProps) {
  const { t } = useI18n();
  const s = t.workspace;
  const [requestedPath, setRequestedPath] = useState<string | undefined>(initialPath || undefined);
  const [manualPath, setManualPath] = useState(initialPath ?? '');
  const [showHidden, setShowHidden] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [isSelecting, setIsSelecting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const listing = useDirectoryListing(requestedPath, open);
  const visibleEntries = useMemo(
    () => listing.data?.entries.filter((entry) => showHidden || !entry.hidden) ?? [],
    [listing.data?.entries, showHidden]
  );

  useEffect(() => {
    if (!open) return;
    setRequestedPath(initialPath || undefined);
    setManualPath(initialPath ?? '');
    setShowHidden(false);
    setActionError(null);
  }, [initialPath, open]);

  useEffect(() => {
    if (!listing.data?.path) return;
    setManualPath(listing.data.path);
  }, [listing.data?.path]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  const browse = (path: string) => {
    setActionError(null);
    setRequestedPath(path);
  };

  const handleManualBrowse = async (event: FormEvent) => {
    event.preventDefault();
    const candidate = manualPath.trim();
    if (!candidate) {
      setActionError(s.validationError);
      return;
    }

    setIsValidating(true);
    setActionError(null);
    try {
      const validation = await validateWorkspacePath(candidate);
      if (!validation.ok || !validation.resolvedPath) {
        setActionError(
          validationMessage(validation.reason, s.validationReasons, s.validationError)
        );
        return;
      }
      browse(validation.resolvedPath);
    } catch (error) {
      setActionError(resolveApiErrorMessage(error, s.validationError));
    } finally {
      setIsValidating(false);
    }
  };

  const handleSelect = async (path: string) => {
    setIsSelecting(true);
    setActionError(null);
    try {
      await onSelect(path);
    } catch (error) {
      setActionError(resolveApiErrorMessage(error, s.selectionError));
    } finally {
      setIsSelecting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-3 backdrop-blur-sm sm:p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="workdir-picker-title"
        className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-outline-variant/20 bg-surface-container-high shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-outline-variant/15 px-5 py-4 sm:px-6 sm:py-5">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2 text-primary">
              <Server size={16} />
              <span className="font-label text-[10px] font-bold uppercase tracking-[0.18em]">
                {s.serverLabel}
              </span>
            </div>
            <h2 id="workdir-picker-title" className="text-xl font-bold text-on-surface">
              {s.title}
            </h2>
            <p className="text-sm text-on-surface-variant/65">{s.description}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl p-2 text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-on-surface"
            aria-label={s.close}
          >
            <X size={18} />
          </button>
        </header>

        <form
          onSubmit={(event) => void handleManualBrowse(event)}
          className="flex flex-col gap-2 border-b border-outline-variant/15 bg-surface-container-lowest/50 px-5 py-3 sm:flex-row sm:items-end sm:px-6"
        >
          <label className="min-w-0 flex-1 space-y-1.5">
            <span className="font-label text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70">
              {s.manualPathLabel}
            </span>
            <input
              value={manualPath}
              onChange={(event) => setManualPath(event.target.value)}
              placeholder={s.manualPathPlaceholder}
              className="w-full rounded-xl border border-outline-variant/20 bg-surface-container-high px-3 py-2 font-mono text-sm text-on-surface outline-none transition-colors placeholder:text-on-surface-variant/35 focus:border-primary/50 focus:ring-1 focus:ring-primary/20"
            />
          </label>
          <Button type="submit" variant="secondary" loading={isValidating}>
            <FolderOpen size={15} />
            {s.browse}
          </Button>
        </form>

        <div className="grid min-h-0 flex-1 sm:grid-cols-[14rem_minmax(0,1fr)]">
          <aside className="hidden min-h-0 overflow-y-auto border-r border-outline-variant/15 bg-surface-container-lowest/35 p-3 sm:block">
            <nav className="space-y-4" aria-label={s.title}>
              {listing.data ? (
                <PathSection label={s.home}>
                  <PathButton
                    icon={<Home size={14} />}
                    label={s.home}
                    path={listing.data.home}
                    onClick={browse}
                  />
                </PathSection>
              ) : null}

              {listing.data?.roots.length ? (
                <PathSection label={s.roots}>
                  {listing.data.roots.map((root) => (
                    <PathButton
                      key={root}
                      icon={<HardDrive size={14} />}
                      label={root}
                      path={root}
                      onClick={browse}
                    />
                  ))}
                </PathSection>
              ) : null}

              <PathSection label={s.recent}>
                {recentWorkdirs.length > 0 ? (
                  recentWorkdirs.map((path) => (
                    <PathButton
                      key={path}
                      icon={<Folder size={14} />}
                      label={path}
                      path={path}
                      onClick={browse}
                    />
                  ))
                ) : (
                  <p className="px-2 text-xs text-on-surface-variant/45">{s.noRecent}</p>
                )}
              </PathSection>
            </nav>
          </aside>

          <main className="flex min-h-[20rem] min-w-0 flex-col">
            <div className="flex items-center gap-2 border-b border-outline-variant/15 px-4 py-3 sm:px-5">
              <button
                type="button"
                onClick={() => listing.data?.parent && browse(listing.data.parent)}
                disabled={!listing.data?.parent}
                className="rounded-lg p-1.5 text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-on-surface disabled:opacity-30"
                aria-label={s.parent}
              >
                <ArrowUp size={16} />
              </button>
              <div className="min-w-0 flex-1 rounded-lg border border-outline-variant/15 bg-surface-container-lowest px-3 py-1.5 font-mono text-xs text-on-surface-variant">
                <span className="block truncate" title={listing.data?.path ?? manualPath}>
                  {listing.data?.path ?? manualPath}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setShowHidden((current) => !current)}
                className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-on-surface"
                aria-pressed={showHidden}
                title={showHidden ? s.hideHidden : s.showHidden}
              >
                {showHidden ? <EyeOff size={15} /> : <Eye size={15} />}
                <span className="hidden md:inline">{showHidden ? s.hideHidden : s.showHidden}</span>
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
              {listing.isLoading ? (
                <div className="flex h-full min-h-48 items-center justify-center gap-2 text-sm text-on-surface-variant">
                  <LoaderCircle size={18} className="animate-spin text-primary" />
                  {s.loading}
                </div>
              ) : listing.isError ? (
                <div className="flex h-full min-h-48 items-center justify-center text-center text-sm text-error">
                  {resolveApiErrorMessage(listing.error, s.loadError)}
                </div>
              ) : visibleEntries.length === 0 ? (
                <div className="flex h-full min-h-48 items-center justify-center text-center text-sm text-on-surface-variant/60">
                  {s.empty}
                </div>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {visibleEntries.map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      onClick={() => browse(entry.path)}
                      className="group flex min-w-0 items-center gap-3 rounded-xl border border-outline-variant/15 bg-surface-container-lowest px-3 py-3 text-left transition-colors hover:border-primary/30 hover:bg-primary/5"
                      title={entry.path}
                    >
                      <span className="rounded-lg bg-primary/10 p-2 text-primary transition-colors group-hover:bg-primary/15">
                        <Folder size={17} fill="currentColor" className="fill-primary/20" />
                      </span>
                      <span className="min-w-0 truncate text-sm font-medium text-on-surface">
                        {entry.name}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </main>
        </div>

        <footer className="flex flex-col gap-3 border-t border-outline-variant/15 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="min-h-5 text-xs text-error" role="alert">
            {actionError}
          </div>
          <div className="flex justify-end gap-2">
            {showUseDefault && defaultWorkdir ? (
              <Button
                type="button"
                variant="ghost"
                disabled={isSelecting}
                onClick={() => void handleSelect(defaultWorkdir)}
              >
                {s.useDefault}
              </Button>
            ) : null}
            <Button
              type="button"
              disabled={!listing.data?.path}
              loading={isSelecting}
              onClick={() => listing.data?.path && void handleSelect(listing.data.path)}
            >
              <FolderOpen size={15} />
              {s.selectFolder}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function PathSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="px-2 font-label text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/55">
        {label}
      </h3>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function PathButton({
  icon,
  label,
  path,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  path: string;
  onClick: (path: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onClick(path)}
      className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
      title={path}
    >
      <span className="shrink-0 text-primary/75">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}
