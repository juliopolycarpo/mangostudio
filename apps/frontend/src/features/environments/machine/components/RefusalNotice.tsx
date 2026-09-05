/**
 * How every "MangoStudio will not upgrade itself here" answer is presented:
 * the reason in prose, and the command to run instead. Three places reach
 * this state — the version line's action, a dialog refused before it streamed,
 * and a stream that ended in a `refused` report — and they differ only in how
 * they word the reason, never in how it is laid out.
 */

import { useI18n } from '@/hooks/use-i18n';
import { CopyLine } from '../../components/CopyLine';

interface RefusalNoticeProps {
  /** Already-localized prose; null when this refusal has nothing to say beyond the command. */
  readonly reasonLine: string | null;
  /** The command that does what the hub would not; null when none applies. */
  readonly command: string | null;
  readonly testId?: string;
}

export function RefusalNotice({ reasonLine, command, testId }: RefusalNoticeProps) {
  const { t } = useI18n();
  return (
    <div className="space-y-2" {...(testId ? { 'data-testid': testId } : {})}>
      {reasonLine && <p className="text-sm text-on-surface-variant">{reasonLine}</p>}
      {command && <CopyLine label={t.environments.machine.actions.runInstead} value={command} />}
    </div>
  );
}
