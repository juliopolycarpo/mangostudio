/**
 * Turns one activity event into a row: a sentence, an icon, and the tone its
 * dot renders in. Pure and exhaustive over `event.kind` — a switch with no
 * `default` — so a new kind added to the shared contract is a typecheck
 * failure here rather than a silently blank row.
 *
 * Vendor names are never hand-mapped a second time: `t.library.targets` already
 * owns the name every library, quota and runner surface spells out. The
 * sidebar's `runnerBadge` labels are deliberately lowercase mono chip text and
 * are the wrong register for a sentence.
 */

import type { ActivityEvent } from '@mangostudio/shared/activity';
import type { Messages } from '@mangostudio/shared/i18n';
import type { LibraryTargetId, ResourceKind } from '@mangostudio/shared/library';
import {
  Bot,
  CheckCircle2,
  FileText,
  Gauge,
  GitCommitHorizontal,
  type LucideIcon,
  MessageSquarePlus,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  SlidersHorizontal,
  Sparkles,
  SquareSlash,
  UploadCloud,
  Webhook,
} from 'lucide-react';
import type { StatusDotTone } from '@/components/ui/StatusDot';
import { formatList, formatMessage } from '@/lib/i18n-format';

export interface ActivityDescription {
  readonly text: string;
  readonly icon: LucideIcon;
  readonly tone: StatusDotTone;
}

/** How far into the quota an event has to read before the row reads as a warning. */
const QUOTA_WARNING_PERCENT = 90;

/**
 * Carries the resource kind, so the sentence can lead with the slug the reader
 * recognizes instead of spending its first word on a category.
 */
const PROPAGATION_ICONS: Record<ResourceKind, LucideIcon> = {
  skill: Sparkles,
  subagent: Bot,
  command: SquareSlash,
  instruction: FileText,
  setting: SlidersHorizontal,
  hook: Webhook,
};

function targetName(t: Messages, targetId: string): string {
  return t.library.targets[targetId as LibraryTargetId] ?? targetId;
}

export function describeActivity(
  event: ActivityEvent,
  t: Messages,
  locale: string
): ActivityDescription {
  const labels = t.home.activity;

  switch (event.kind) {
    case 'chat_created':
      return {
        text: formatMessage(labels.chatCreated, { title: event.payload.title }),
        icon: MessageSquarePlus,
        tone: 'accent',
      };

    case 'turn_completed': {
      // `t.library.targets`, not `t.sidebar.runner`: the sidebar's labels are
      // deliberately lowercase mono chip text, and "codex answered in …" reads
      // as a typo in a sentence.
      const runner =
        event.payload.runner.kind === 'external'
          ? targetName(t, event.payload.runner.targetId)
          : t.library.targets.mangostudio;
      return {
        text: formatMessage(labels.turnCompleted, { runner, title: event.payload.title }),
        icon: CheckCircle2,
        tone: 'success',
      };
    }

    case 'commit_created': {
      const text = event.payload.branch
        ? formatMessage(labels.commitCreatedOnBranch, {
            subject: event.payload.subject,
            branch: event.payload.branch,
          })
        : formatMessage(labels.commitCreated, { subject: event.payload.subject });
      return { text, icon: GitCommitHorizontal, tone: 'accent' };
    }

    case 'branch_pushed':
      return {
        text: formatMessage(labels.branchPushed, {
          branch: event.payload.branch,
          remote: event.payload.remote,
        }),
        icon: UploadCloud,
        tone: 'accent',
      };

    case 'propagation_applied': {
      // The slug, not the kind label: `frontend-design` is what the reader
      // recognizes, and the kind is already carried by the row's icon.
      const name = event.payload.resourceName;
      const text =
        event.payload.targets.length > 0
          ? formatMessage(labels.propagationApplied, {
              name,
              targets: formatList(
                event.payload.targets.map((id) => targetName(t, id)),
                locale
              ),
            })
          : formatMessage(labels.propagationAppliedNoTargets, { name });
      return { text, icon: PROPAGATION_ICONS[event.payload.resourceKind], tone: 'accent' };
    }

    case 'quota_refreshed': {
      const text = formatMessage(labels.quotaRefreshed, {
        target: targetName(t, event.payload.target),
        used: String(Math.round(event.payload.usedPercent)),
        previous: String(Math.round(event.payload.previousUsedPercent)),
      });
      return {
        text,
        icon: Gauge,
        tone: event.payload.usedPercent >= QUOTA_WARNING_PERCENT ? 'warning' : 'neutral',
      };
    }

    case 'environment_health_changed': {
      const name = event.payload.environmentName;
      if (event.payload.state === 'connected') {
        return {
          text: formatMessage(labels.environmentConnected, { name }),
          icon: ShieldCheck,
          tone: 'success',
        };
      }
      if (event.payload.state === 'error') {
        return {
          text: formatMessage(labels.environmentError, { name }),
          icon: ShieldAlert,
          tone: 'error',
        };
      }
      // `disconnected` is the only other settled state this kind ever
      // carries (see the schema note on `payload.state`); `connecting` is a
      // step rather than an outcome and is never recorded, but the branch
      // reads the same sentence rather than leaving a row with none.
      return {
        text: formatMessage(labels.environmentDisconnected, { name }),
        icon: ShieldOff,
        tone: 'neutral',
      };
    }
  }
}
