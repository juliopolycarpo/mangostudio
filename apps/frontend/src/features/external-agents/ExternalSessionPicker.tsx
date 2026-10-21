/**
 * The picker that continues a conversation started in a terminal.
 *
 * Grouped by vendor, because the two listings are genuinely different and
 * pretending otherwise would misrepresent one of them. Codex has a nullable
 * thread name and a preview of the first user message; Cursor's `session/list`
 * carries a session id, a folder and a timestamp and **no title at all**. A
 * Cursor row therefore shows its folder and its age and nothing else — an empty
 * title slot would read as missing data rather than as a fact about the vendor.
 *
 * Claude gets a row too, saying why it has no picker. Leaving it out would look
 * like an oversight; its CLI keeps history in a format its own documentation
 * calls internal and subject to change, and reading that is not something to do
 * quietly behind a feature that promises to continue *the* session someone
 * picked.
 *
 * The workspace filter defaults on. A session for a different repository is
 * almost never what anyone means by "continue what I was doing", and the
 * adoption call is filtered by the same folder, so an unfiltered browse is an
 * explicit choice rather than the default one.
 */

import type {
  ExternalAgentDescriptor,
  ExternalAgentTargetId,
  ExternalNativeSession,
} from '@mangostudio/shared/external-agents';
import { EXTERNAL_AGENT_TARGET_IDS } from '@mangostudio/shared/external-agents';
import { Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Checkbox } from '@/components/ui/Checkbox';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { Spinner } from '@/components/ui/Spinner';
import { useFocusTrap } from '@/hooks/use-focus-trap';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';
import { listExternalNativeSessions } from '@/services/external-agent-service';
import { ExternalDialog } from './ExternalDialog';

export interface ExternalSessionPickerProps {
  readonly environmentId: string;
  readonly environmentName: string;
  /** The chat's own folder, when it has one. Absent disables the filter entirely. */
  readonly workspacePath?: string;
  readonly agents: readonly ExternalAgentDescriptor[];
  readonly adoptingId?: string;
  readonly onAdopt: (session: ExternalNativeSession) => void;
  readonly onClose: () => void;
  /** Bumped by the container after a stale adoption, to force a reload. */
  readonly reloadToken?: number;
}

interface TargetPage {
  readonly sessions: readonly ExternalNativeSession[];
  readonly nextCursor?: string;
}

type TargetState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly page: TargetPage }
  | { readonly status: 'failed' };

export function ExternalSessionPicker({
  environmentId,
  environmentName,
  workspacePath,
  agents,
  adoptingId,
  onAdopt,
  onClose,
  reloadToken = 0,
}: ExternalSessionPickerProps) {
  const { t } = useI18n();
  const labels = t.externalAgents.sessions;
  const dialogRef = useFocusTrap(onClose);
  const [thisWorkspaceOnly, setThisWorkspaceOnly] = useState(workspacePath !== undefined);
  const [states, setStates] = useState<Partial<Record<ExternalAgentTargetId, TargetState>>>({});

  // Only the targets whose adapter says it can enumerate. The flag is derived
  // on the runtime from whether the adapter implements a listing at all, so a
  // target missing here is one that genuinely has nothing to show.
  const listable = agents.filter((agent) => agent.capabilities.sessionListing);
  const listableKey = listable.map((agent) => agent.targetId).join(',');
  const filter = thisWorkspaceOnly ? workspacePath : undefined;

  const load = useCallback(
    (targetId: ExternalAgentTargetId, cursor?: string) => {
      setStates((previous) => ({
        ...previous,
        ...(cursor ? {} : { [targetId]: { status: 'loading' as const } }),
      }));
      return listExternalNativeSessions({
        environmentId,
        targetId,
        ...(filter ? { workspacePath: filter } : {}),
        ...(cursor ? { cursor } : {}),
      })
        .then((response) => {
          setStates((previous) => {
            const existing = previous[targetId];
            // A "show more" appends; a fresh load replaces. Reading the page off
            // the previous state rather than off a captured value keeps two
            // pages that resolved out of order from dropping one of them.
            const before =
              cursor && existing?.status === 'ready' ? existing.page.sessions : ([] as const);
            return {
              ...previous,
              [targetId]: {
                status: 'ready',
                page: {
                  sessions: [...before, ...response.sessions],
                  ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}),
                },
              },
            };
          });
        })
        .catch(() => {
          setStates((previous) => ({ ...previous, [targetId]: { status: 'failed' as const } }));
        });
    },
    [environmentId, filter]
  );

  useEffect(() => {
    for (const targetId of listableKey.split(',').filter(Boolean)) {
      void load(targetId as ExternalAgentTargetId);
    }
    // `listableKey` stands in for the descriptor list: a new object identity on
    // every render would otherwise re-list every vendor on every keystroke.
  }, [listableKey, load, reloadToken]);

  return (
    <ExternalDialog
      dialogRef={dialogRef}
      label={labels.title}
      title={labels.title}
      description={labels.subtitle.replace('{environment}', environmentName)}
      size="lg"
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t.externalAgents.disclosure.close}
        </Button>
      }
    >
      {workspacePath ? (
        <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-fg">
          <Checkbox
            checked={thisWorkspaceOnly}
            onChange={(event) => setThisWorkspaceOnly(event.target.checked)}
          />
          {labels.thisWorkspaceOnly}
        </label>
      ) : null}

      <div className="space-y-5">
        {EXTERNAL_AGENT_TARGET_IDS.map((targetId) => {
          const descriptor = agents.find((agent) => agent.targetId === targetId);
          if (!descriptor) return null;
          return (
            <TargetGroup
              key={targetId}
              targetId={targetId}
              canList={descriptor.capabilities.sessionListing}
              state={states[targetId]}
              adoptingId={adoptingId}
              filtered={filter !== undefined}
              onAdopt={onAdopt}
              onLoadMore={(cursor) => void load(targetId, cursor)}
            />
          );
        })}
      </div>
    </ExternalDialog>
  );
}

function TargetGroup({
  targetId,
  canList,
  state,
  adoptingId,
  filtered,
  onAdopt,
  onLoadMore,
}: {
  targetId: ExternalAgentTargetId;
  canList: boolean;
  state: TargetState | undefined;
  adoptingId?: string;
  filtered: boolean;
  onAdopt: (session: ExternalNativeSession) => void;
  onLoadMore: (cursor: string) => void;
}) {
  const { t } = useI18n();
  const labels = t.externalAgents.sessions;

  return (
    <section className="space-y-2">
      <MicroLabel as="h3">{t.externalAgents.target[targetId]}</MicroLabel>

      {!canList ? (
        <p className="text-xs text-fg-muted">
          {targetId === 'claude' ? labels.unsupportedClaude : labels.unsupported}
        </p>
      ) : state === undefined || state.status === 'loading' ? (
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          <Spinner size="sm" />
          {labels.loading}
        </div>
      ) : state.status === 'failed' ? (
        <Callout tone="danger">{labels.loadFailed}</Callout>
      ) : state.page.sessions.length === 0 ? (
        <p className="text-xs text-fg-muted">{filtered ? labels.emptyInWorkspace : labels.empty}</p>
      ) : (
        <>
          <ul className="space-y-1">
            {state.page.sessions.map((session) => (
              <li key={session.nativeSessionId}>
                <SessionRow
                  session={session}
                  busy={adoptingId === session.nativeSessionId}
                  disabled={adoptingId !== undefined}
                  onAdopt={() => onAdopt(session)}
                />
              </li>
            ))}
          </ul>
          {state.page.nextCursor ? (
            <Button
              variant="subtle"
              size="sm"
              onClick={() => onLoadMore(state.page.nextCursor as string)}
            >
              <RefreshCw size={ICON_SM} />
              {labels.loadMore}
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * One session.
 *
 * The heading is the vendor's title, then its preview, then nothing — and
 * "nothing" is a real branch rather than a fallback string for every vendor.
 * Cursor supplies neither, so its rows lead with the folder; only a target that
 * *should* have had text and did not gets the placeholder.
 *
 * Both strings are third-party text. They arrive already stripped of control
 * characters and cut to the session-title bound at the runtime boundary, and
 * they render as text nodes — never as markdown, never as HTML.
 */
function SessionRow({
  session,
  busy,
  disabled,
  onAdopt,
}: {
  session: ExternalNativeSession;
  busy: boolean;
  disabled: boolean;
  onAdopt: () => void;
}) {
  const { t } = useI18n();
  const labels = t.externalAgents.sessions;
  const heading = session.title ?? session.preview;

  return (
    <button
      type="button"
      onClick={onAdopt}
      disabled={disabled}
      className="flex w-full flex-col items-start gap-0.5 rounded-sm px-3 py-2 text-left transition-colors enabled:hover:bg-fill-hover disabled:opacity-50"
    >
      {heading ? (
        <span className="w-full truncate text-sm text-fg">{heading}</span>
      ) : session.workspacePath ? null : (
        <span className="w-full truncate text-sm text-fg-muted">{labels.noTitle}</span>
      )}
      <span className="flex w-full items-center gap-2 font-mono text-micro text-fg-subtle">
        {session.workspacePath ? (
          <span className="min-w-0 flex-1 truncate">{session.workspacePath}</span>
        ) : null}
        <span className="shrink-0">{relativeAge(session.updatedAtMs, labels)}</span>
        {busy ? <Loader2 size={ICON_SM} className="shrink-0 animate-spin" /> : null}
      </span>
    </button>
  );
}

/**
 * How long ago, coarsely.
 *
 * Coarse on purpose: the exact second a vendor last touched a thread is noise
 * beside "this morning". An absent timestamp renders as nothing rather than as
 * an epoch date — a row whose age the vendor did not report is still adoptable.
 */
function relativeAge(
  updatedAtMs: number | undefined,
  labels: { ageJustNow: string; ageMinutes: string; ageHours: string; ageDays: string }
): string {
  if (updatedAtMs === undefined) return '';
  const elapsed = Date.now() - updatedAtMs;
  if (elapsed < 60_000) return labels.ageJustNow;
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return labels.ageMinutes.replace('{count}', String(minutes));
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return labels.ageHours.replace('{count}', String(hours));
  return labels.ageDays.replace('{count}', String(Math.floor(hours / 24)));
}
