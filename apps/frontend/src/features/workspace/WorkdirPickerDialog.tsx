import { ERROR_CODES } from '@mangostudio/shared/errors';
import type { WorkdirValidationReason } from '@mangostudio/shared/workspaces';
import {
  ArrowUp,
  CircleX,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  HardDrive,
  Home,
  Server,
  X,
} from 'lucide-react';
import { type FormEvent, useEffect, useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { Select } from '@/components/ui/Select';
import { Spinner } from '@/components/ui/Spinner';
import { useFocusTrap } from '@/hooks/use-focus-trap';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD, ICON_SM } from '@/lib/icon-sizes';
import { ApiError, resolveApiErrorMessage } from '@/lib/utils';
import { IconButton } from './components/IconButton';
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
  const manualPathId = useId();
  const restrictToolsId = useId();
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
        className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-stroke bg-surface-raised shadow-dialog outline-none"
      >
        <header className="flex items-start justify-between gap-4 border-b border-stroke px-4 py-4 sm:px-6">
          <div className="min-w-0 space-y-1">
            <MicroLabel className="flex items-center gap-1.5">
              <Server size={ICON_SM} />
              {s.serverLabel}
            </MicroLabel>
            <h2 id="workdir-picker-title" className="text-title font-semibold text-fg">
              {s.title}
            </h2>
            <p className="text-sm text-fg-muted">{s.description}</p>
          </div>
          <IconButton label={s.close} onClick={onClose}>
            <X size={ICON_MD} />
          </IconButton>
        </header>

        <form
          onSubmit={(event) => void handleManualBrowse(event)}
          className="flex flex-col gap-2 border-b border-stroke px-4 py-3 sm:flex-row sm:items-end sm:px-6"
        >
          <div className="min-w-0 flex-1">
            <Input
              id={manualPathId}
              label={s.manualPathLabel}
              value={manualPath}
              onChange={(event) => setManualPath(event.target.value)}
              placeholder={s.manualPathPlaceholder}
              className="font-mono"
            />
          </div>
          <Button type="submit" variant="secondary" loading={isValidating}>
            <FolderOpen size={ICON_MD} />
            {s.browse}
          </Button>
        </form>

        <div className="grid min-h-0 flex-1 sm:grid-cols-[14rem_minmax(0,1fr)]">
          <aside className="app-scrollbar hidden min-h-0 overflow-y-auto border-r border-stroke p-3 sm:block">
            <nav className="space-y-4" aria-label={s.title}>
              {listing.data ? (
                <PathSection label={s.home}>
                  <PathButton
                    icon={<Home size={ICON_MD} />}
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
                      icon={<HardDrive size={ICON_MD} />}
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
                      icon={<Folder size={ICON_MD} />}
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
            <div className="flex items-center gap-2 border-b border-stroke px-4 py-3">
              <IconButton
                label={s.parent}
                onClick={() => listing.data?.parent && browse(listing.data.parent)}
                disabled={!listing.data?.parent}
              >
                <ArrowUp size={ICON_MD} />
              </IconButton>
              <div className="flex h-8 min-w-0 flex-1 items-center rounded-sm border border-stroke bg-control px-3 font-mono text-xs text-fg-muted">
                <span className="block truncate" title={listing.data?.path ?? manualPath}>
                  {listing.data?.path ?? manualPath}
                </span>
              </div>
              <Button
                type="button"
                variant="subtle"
                size="sm"
                onClick={() => setShowHidden((current) => !current)}
                aria-pressed={showHidden}
                title={showHidden ? s.hideHidden : s.showHidden}
                className="text-fg-muted aria-pressed:bg-fill-selected aria-pressed:text-fg"
              >
                {showHidden ? <EyeOff size={ICON_SM} /> : <Eye size={ICON_SM} />}
                <span className="hidden md:inline">{showHidden ? s.hideHidden : s.showHidden}</span>
              </Button>
            </div>

            <div className="app-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              {/* Hoisted above the list branches: hidden entries can consume the whole
                  cap, leaving a visibly empty folder that is nonetheless truncated. */}
              {listing.data?.truncated ? (
                <Callout tone="info" role="status">
                  {s.truncatedNotice.replace('{count}', String(listing.data.entries.length))}
                </Callout>
              ) : null}
              {listing.isLoading ? (
                <EmptyState icon={<Spinner />} title={s.loading} className="h-full min-h-48" />
              ) : listing.isError ? (
                <Callout tone="danger">{browseErrorMessage(listing.error, s)}</Callout>
              ) : visibleEntries.length === 0 ? (
                <EmptyState title={s.empty} className="h-full min-h-48" />
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {visibleEntries.map((entry) => (
                    <Button
                      key={entry.path}
                      type="button"
                      variant="secondary"
                      onClick={() => browse(entry.path)}
                      className="min-w-0 justify-start"
                      title={entry.path}
                    >
                      <Folder size={ICON_MD} className="shrink-0 text-fg-muted" />
                      <span className="min-w-0 truncate">{entry.name}</span>
                    </Button>
                  ))}
                </div>
              )}
            </div>
          </main>
        </div>

        {showRestrictToolsOverride && onRestrictToolsToWorkdirOverrideChange ? (
          <div className="space-y-1 border-t border-stroke px-4 py-4 sm:px-6">
            <label htmlFor={restrictToolsId} className="block text-sm font-medium text-fg">
              {s.restrictToolsChatOverrideLabel}
            </label>
            <Select
              id={restrictToolsId}
              value={
                restrictToolsToWorkdirOverride === null
                  ? 'inherit'
                  : restrictToolsToWorkdirOverride
                    ? 'on'
                    : 'off'
              }
              onChange={(value) => {
                const next = value === 'inherit' ? null : value === 'on';
                void onRestrictToolsToWorkdirOverrideChange(next);
              }}
              options={[
                {
                  value: 'inherit',
                  label: s.restrictToolsInherit.replace(
                    '{state}',
                    globalRestrictToolsToWorkdir
                      ? s.restrictToolsGlobalOn
                      : s.restrictToolsGlobalOff
                  ),
                },
                { value: 'on', label: s.restrictToolsOn },
                { value: 'off', label: s.restrictToolsOff },
              ]}
            />
          </div>
        ) : null}

        <footer className="flex flex-col gap-3 border-t border-stroke bg-canvas px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex min-h-5 items-center gap-1.5 text-xs text-danger" role="alert">
            {actionError ? (
              <>
                <CircleX size={ICON_SM} className="shrink-0" aria-hidden="true" />
                {actionError}
              </>
            ) : null}
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
              <FolderOpen size={ICON_MD} />
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
    <section className="space-y-1">
      <MicroLabel as="h3" className="block px-2">
        {label}
      </MicroLabel>
      <div>{children}</div>
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
      className="flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-sm text-fg-muted transition-colors hover:bg-fill-hover hover:text-fg"
      title={path}
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}
