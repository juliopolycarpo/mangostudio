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
import { Dialog } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { Select } from '@/components/ui/Select';
import { Spinner } from '@/components/ui/Spinner';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD, ICON_SM } from '@/lib/icon-sizes';
import { workdirLabel } from '@/lib/paths';
import { ApiError, cn, resolveApiErrorMessage } from '@/lib/utils';
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
    // The palette that opens this dialog hands off focus mid-exit-animation
    // rather than after unmount; the dialog's trap takes focus itself instead of
    // relying on whatever last had it.
    <Dialog
      size="lg"
      flush
      eyebrow={
        <MicroLabel className="flex items-center gap-1.5">
          <Server size={ICON_SM} />
          {s.serverLabel}
        </MicroLabel>
      }
      title={s.title}
      description={s.description}
      headerAction={
        <IconButton label={s.close} onClick={onClose}>
          <X size={ICON_MD} />
        </IconButton>
      }
      onClose={onClose}
      footer={
        <>
          <div
            className="flex min-h-5 min-w-0 basis-full items-center gap-1.5 text-xs text-danger sm:flex-1 sm:basis-0"
            role="alert"
          >
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
        </>
      }
    >
      <form
        onSubmit={(event) => void handleManualBrowse(event)}
        className="flex flex-col gap-2 border-b border-stroke px-6 py-3 sm:flex-row sm:items-end"
      >
        {/* The one place the current folder is written: browsing a folder fills
            this field, and typing a path then Enter (or Open) goes there. */}
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
        <aside className="app-scrollbar hidden min-h-0 overflow-y-auto border-r border-stroke p-4 sm:block">
          <nav className="space-y-4" aria-label={s.title}>
            {/* Home and the filesystem roots are one group: under a heading each
                they were two one-row sections whose labels only restated the row
                (`HOME` over “Home”). */}
            {listing.data ? (
              <PathSection label={s.places}>
                <PathButton
                  icon={<Home size={ICON_MD} />}
                  label={s.home}
                  path={listing.data.home}
                  onClick={browse}
                />
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
                    label={workdirLabel(path) ?? path}
                    detail={parentPath(path)}
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
          <div className="flex items-center justify-between gap-2 border-b border-stroke px-6 py-3">
            <IconButton
              label={s.parent}
              onClick={() => listing.data?.parent && browse(listing.data.parent)}
              disabled={!listing.data?.parent}
            >
              <ArrowUp size={ICON_MD} />
            </IconButton>
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
              // A list is a stack of rows with a hover wash, the way the rail beside
              // it is drawn; a bordered button per folder made the heaviest pane in
              // the app out of a directory listing.
              <div className="space-y-0.5">
                {visibleEntries.map((entry) => (
                  <PathButton
                    key={entry.path}
                    icon={<Folder size={ICON_MD} />}
                    label={entry.name}
                    path={entry.path}
                    onClick={browse}
                    className="text-fg"
                  />
                ))}
              </div>
            )}
          </div>
        </main>
      </div>

      {showRestrictToolsOverride && onRestrictToolsToWorkdirOverrideChange ? (
        <div className="space-y-1 border-t border-stroke px-6 py-4">
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
                  globalRestrictToolsToWorkdir ? s.restrictToolsGlobalOn : s.restrictToolsGlobalOff
                ),
              },
              { value: 'on', label: s.restrictToolsOn },
              { value: 'off', label: s.restrictToolsOff },
            ]}
          />
        </div>
      ) : null}
    </Dialog>
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

/**
 * The folder above a path, for the line under a name that is not enough alone
 * (`/tmp/mangostudio-visual-1` and `-2` share a parent, so the parent is only
 * worth showing dimmed). Null for a root-level path, which has no parent worth
 * naming.
 */
function parentPath(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut > 0 ? trimmed.slice(0, cut) : null;
}

/**
 * One folder as a row: icon, its name, and optionally its parent path dimmed on
 * a second line. The name comes first because it is the part that tells two
 * folders apart — a path truncated at the end cut exactly that off.
 */
function PathButton({
  icon,
  label,
  detail = null,
  path,
  onClick,
  className,
}: {
  icon: React.ReactNode;
  label: string;
  /** The parent folder, shown under the name in `fg-subtle`. */
  detail?: string | null;
  path: string;
  onClick: (path: string) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onClick(path)}
      className={cn(
        'flex min-h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-sm px-2 py-0.5 text-left text-sm text-fg-muted transition-colors hover:bg-fill-hover hover:text-fg',
        className
      )}
      title={path}
    >
      <span className="shrink-0">{icon}</span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{label}</span>
        {detail ? <span className="truncate text-xs text-fg-subtle">{detail}</span> : null}
      </span>
    </button>
  );
}
