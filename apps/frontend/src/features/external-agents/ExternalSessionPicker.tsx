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
import { Check, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useFocusTrap } from '@/hooks/use-focus-trap';
import { useI18n } from '@/hooks/use-i18n';
import { listExternalNativeSessions } from '@/services/external-agent-service';

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={labels.title}
        className="flex max-h-[80vh] w-full max-w-xl flex-col gap-3 rounded-2xl border border-outline-variant/15 bg-surface-container-low p-5 text-sm text-on-surface shadow-2xl outline-none"
      >
        <div className="space-y-1">
          <h2 className="text-base font-semibold">{labels.title}</h2>
          <p className="text-xs leading-relaxed text-on-surface-variant">
            {labels.subtitle.replace('{environment}', environmentName)}
          </p>
        </div>

        {workspacePath ? (
          <button
            type="button"
            aria-pressed={thisWorkspaceOnly}
            onClick={() => setThisWorkspaceOnly((value) => !value)}
            className="flex w-fit items-center gap-2 rounded-full border border-outline-variant/20 px-3 py-1 text-xs text-on-surface-variant transition-colors hover:bg-surface-container-high"
          >
            <span
              className={`flex h-3.5 w-3.5 items-center justify-center rounded border ${
                thisWorkspaceOnly
                  ? 'border-primary bg-primary text-on-primary'
                  : 'border-outline-variant/40'
              }`}
            >
              {thisWorkspaceOnly ? <Check size={10} /> : null}
            </span>
            {labels.thisWorkspaceOnly}
          </button>
        ) : null}

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
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

        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-xl border border-outline-variant/20 px-3 py-2 text-sm text-on-surface-variant transition-colors hover:bg-surface-container-high"
          >
            {t.externalAgents.disclosure.close}
          </button>
        </div>
      </div>
    </div>
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
    <section className="space-y-1">
      <h3 className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70">
        {t.externalAgents.target[targetId]}
      </h3>

      {!canList ? (
        <p className="px-1 text-[11px] leading-relaxed text-on-surface-variant/70">
          {targetId === 'claude' ? labels.unsupportedClaude : labels.unsupported}
        </p>
      ) : state === undefined || state.status === 'loading' ? (
        <p className="flex items-center gap-2 px-1 text-[11px] text-on-surface-variant/70">
          <Loader2 size={12} className="animate-spin" />
          {labels.loading}
        </p>
      ) : state.status === 'failed' ? (
        <p className="px-1 text-[11px] text-error/80">{labels.loadFailed}</p>
      ) : state.page.sessions.length === 0 ? (
        <p className="px-1 text-[11px] text-on-surface-variant/70">
          {filtered ? labels.emptyInWorkspace : labels.empty}
        </p>
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
            <button
              type="button"
              onClick={() => onLoadMore(state.page.nextCursor as string)}
              className="flex items-center gap-1 px-1 py-1 text-[11px] text-on-surface-variant/70 transition-colors hover:text-on-surface"
            >
              <RefreshCw size={11} />
              {labels.loadMore}
            </button>
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
      className="flex w-full flex-col items-start gap-0.5 rounded-xl px-2 py-2 text-left transition-colors enabled:hover:bg-surface-container-high disabled:opacity-60"
    >
      {heading ? (
        <span className="w-full truncate text-xs text-on-surface">{heading}</span>
      ) : session.workspacePath ? null : (
        <span className="w-full truncate text-xs text-on-surface-variant/70">{labels.noTitle}</span>
      )}
      <span className="flex w-full items-center gap-2 text-[10px] text-on-surface-variant/70">
        {session.workspacePath ? (
          <span className="min-w-0 flex-1 truncate">{session.workspacePath}</span>
        ) : null}
        <span className="shrink-0">{relativeAge(session.updatedAtMs, labels)}</span>
        {busy ? <Loader2 size={10} className="shrink-0 animate-spin" /> : null}
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
