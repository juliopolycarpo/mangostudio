import { ERROR_CODES } from '@mangostudio/shared/errors';
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
import { useFocusTrap } from '@/hooks/use-focus-trap';
import { useI18n } from '@/hooks/use-i18n';
import { ApiError, resolveApiErrorMessage } from '@/lib/utils';
import { useDirectoryListing, validateWorkspacePath } from './use-directory-listing';

interface WorkdirPickerDialogProps {
  open: boolean;
  chatId?: string;
  /**
   * The machine to browse when no chat exists yet — first-run setup picks a
   * folder before it creates one. Ignored when `chatId` is given, which already
   * names a machine through the chat's own environment.
   */
  environmentId?: string;
  initialPath?: string | null;
  defaultWorkdir?: string;
  recentWorkdirs?: ReadonlyArray<string>;
  showUseDefault?: boolean;
  showRestrictToolsOverride?: boolean;
  globalRestrictToolsToWorkdir?: boolean;
  restrictToolsToWorkdirOverride?: boolean | null;
  onRestrictToolsToWorkdirOverrideChange?: (value: boolean | null) => void | Promise<void>;
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

export type WorkdirBrowseErrorMessages = {
  loadError: string;
  validationReasons: {
    notFound: string;
    notDirectory: string;
    permissionDenied: string;
  };
};

export function browseErrorMessage(error: unknown, s: WorkdirBrowseErrorMessages): string {
  if (!(error instanceof ApiError)) {
    return s.loadError;
  }

  switch (error.code) {
    case ERROR_CODES.NOT_FOUND:
      return s.validationReasons.notFound;
    case ERROR_CODES.NOT_A_DIRECTORY:
      return s.validationReasons.notDirectory;
    case ERROR_CODES.PERMISSION_DENIED:
      return s.validationReasons.permissionDenied;
    default:
      return s.loadError;
  }
}

export function WorkdirPickerDialog({
  open,
  chatId,
  environmentId,
  initialPath = null,
  defaultWorkdir = '',
  recentWorkdirs = [],
  showUseDefault = true,
  showRestrictToolsOverride = false,
  globalRestrictToolsToWorkdir = false,
  restrictToolsToWorkdirOverride = null,
  onRestrictToolsToWorkdirOverrideChange,
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
  const scope = useMemo(
    () => (chatId ? { chatId } : environmentId ? { environmentId } : undefined),
    [chatId, environmentId]
  );
  const listing = useDirectoryListing(requestedPath, open, scope);
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

  // The palette that opens this dialog hands off focus to it mid-exit-animation
  // rather than after unmount, so the dialog has to take focus itself instead of
  // relying on whatever last had it. Also traps Tab and takes Escape, replacing
  // the old window-level Escape listener — see the hook for why a stacked
  // overlay needs the `defaultPrevented` guard it carries.
  const dialogRef = useFocusTrap(onClose);

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
      const validation = await validateWorkspacePath(candidate, scope);
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-3 sm:p-6">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="workdir-picker-title"
        tabIndex={-1}
        className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-stroke bg-surface shadow-2xl outline-none"
      >
        <header className="flex items-start justify-between gap-4 border-b border-stroke px-5 py-4 sm:px-6 sm:py-5">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2 text-accent-fg">
              <Server size={16} />
              <span className="text-[10px] font-bold uppercase tracking-[0.18em]">
                {s.serverLabel}
              </span>
            </div>
            <h2 id="workdir-picker-title" className="text-xl font-bold text-fg">
              {s.title}
            </h2>
            <p className="text-sm text-fg-muted">{s.description}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl p-2 text-fg-muted transition-colors hover:bg-fill-hover hover:text-fg"
            aria-label={s.close}
          >
            <X size={18} />
          </button>
        </header>

        <form
          onSubmit={(event) => void handleManualBrowse(event)}
          className="flex flex-col gap-2 border-b border-stroke bg-control px-5 py-3 sm:flex-row sm:items-end sm:px-6"
        >
          <label className="min-w-0 flex-1 space-y-1.5">
            <span className="text-[10px] font-bold uppercase tracking-widest text-fg-muted">
              {s.manualPathLabel}
            </span>
            <input
              value={manualPath}
              onChange={(event) => setManualPath(event.target.value)}
              placeholder={s.manualPathPlaceholder}
              className="w-full rounded-xl border border-stroke bg-surface px-3 py-2 font-mono text-sm text-fg outline-none transition-colors placeholder:text-fg-subtle focus:border-focus focus:ring-1 focus:ring-focus"
            />
          </label>
          <Button type="submit" variant="secondary" loading={isValidating}>
            <FolderOpen size={15} />
            {s.browse}
          </Button>
        </form>

        <div className="grid min-h-0 flex-1 sm:grid-cols-[14rem_minmax(0,1fr)]">
          <aside className="hidden min-h-0 overflow-y-auto border-r border-stroke bg-control p-3 sm:block">
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
                  <p className="px-2 text-xs text-fg-subtle">{s.noRecent}</p>
                )}
              </PathSection>
            </nav>
          </aside>

          <main className="flex min-h-[20rem] min-w-0 flex-col">
            <div className="flex items-center gap-2 border-b border-stroke px-4 py-3 sm:px-5">
              <button
                type="button"
                onClick={() => listing.data?.parent && browse(listing.data.parent)}
                disabled={!listing.data?.parent}
                className="rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-fill-hover hover:text-fg disabled:opacity-30"
                aria-label={s.parent}
              >
                <ArrowUp size={16} />
              </button>
              <div className="min-w-0 flex-1 rounded-lg border border-stroke bg-control px-3 py-1.5 font-mono text-xs text-fg-muted">
                <span className="block truncate" title={listing.data?.path ?? manualPath}>
                  {listing.data?.path ?? manualPath}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setShowHidden((current) => !current)}
                className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-fg-muted transition-colors hover:bg-fill-hover hover:text-fg"
                aria-pressed={showHidden}
                title={showHidden ? s.hideHidden : s.showHidden}
              >
                {showHidden ? <EyeOff size={15} /> : <Eye size={15} />}
                <span className="hidden md:inline">{showHidden ? s.hideHidden : s.showHidden}</span>
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 sm:p-4">
              {/* Hoisted above the list branches: hidden entries can consume the whole
                  cap, leaving a visibly empty folder that is nonetheless truncated. */}
              {listing.data?.truncated ? (
                <p
                  role="status"
                  className="rounded-xl border border-stroke bg-control px-3 py-2 text-xs text-fg-muted"
                >
                  {s.truncatedNotice.replace('{count}', String(listing.data.entries.length))}
                </p>
              ) : null}
              {listing.isLoading ? (
                <div className="flex h-full min-h-48 items-center justify-center gap-2 text-sm text-fg-muted">
                  <LoaderCircle size={18} className="animate-spin text-accent-fg" />
                  {s.loading}
                </div>
              ) : listing.isError ? (
                <div className="flex h-full min-h-48 items-center justify-center text-center text-sm text-danger">
                  {browseErrorMessage(listing.error, s)}
                </div>
              ) : visibleEntries.length === 0 ? (
                <div className="flex h-full min-h-48 items-center justify-center text-center text-sm text-fg-muted">
                  {s.empty}
                </div>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {visibleEntries.map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      onClick={() => browse(entry.path)}
                      className="group flex min-w-0 items-center gap-3 rounded-xl border border-stroke bg-control px-3 py-3 text-left transition-colors hover:border-accent hover:bg-accent-hover"
                      title={entry.path}
                    >
                      <span className="rounded-lg bg-accent-subtle p-2 text-accent-fg transition-colors group-hover:bg-accent-hover">
                        <Folder size={17} fill="currentColor" className="fill-accent-fg" />
                      </span>
                      <span className="min-w-0 truncate text-sm font-medium text-fg">
                        {entry.name}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </main>
        </div>

        {showRestrictToolsOverride && onRestrictToolsToWorkdirOverrideChange ? (
          <div className="border-t border-stroke px-5 py-4 sm:px-6">
            <label
              htmlFor="restrict-tools-override"
              className="mb-2 block text-[10px] font-bold uppercase tracking-widest text-fg-muted"
            >
              {s.restrictToolsChatOverrideLabel}
            </label>
            <select
              id="restrict-tools-override"
              value={
                restrictToolsToWorkdirOverride === null
                  ? 'inherit'
                  : restrictToolsToWorkdirOverride
                    ? 'on'
                    : 'off'
              }
              onChange={(event) => {
                const next = event.target.value === 'inherit' ? null : event.target.value === 'on';
                void onRestrictToolsToWorkdirOverrideChange(next);
              }}
              className="w-full rounded-xl border border-stroke bg-control px-3 py-2 text-sm text-fg outline-none focus:border-focus focus:ring-1 focus:ring-focus"
            >
              <option value="inherit">
                {s.restrictToolsInherit.replace(
                  '{state}',
                  globalRestrictToolsToWorkdir ? s.restrictToolsGlobalOn : s.restrictToolsGlobalOff
                )}
              </option>
              <option value="on">{s.restrictToolsOn}</option>
              <option value="off">{s.restrictToolsOff}</option>
            </select>
          </div>
        ) : null}

        <footer className="flex flex-col gap-3 border-t border-stroke px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="min-h-5 text-xs text-danger" role="alert">
            {actionError}
          </div>
          <div className="flex justify-end gap-2">
            {showUseDefault && defaultWorkdir ? (
              <Button
                type="button"
                variant="subtle"
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
      <h3 className="px-2 text-[10px] font-bold uppercase tracking-widest text-fg-subtle">
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
      className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-fg-muted transition-colors hover:bg-fill-hover hover:text-fg"
      title={path}
    >
      <span className="shrink-0 text-accent-fg">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}
