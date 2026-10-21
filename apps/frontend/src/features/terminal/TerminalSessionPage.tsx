import { TerminalSquare } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD } from '@/lib/icon-sizes';
import { TerminalView } from './TerminalView';

export interface TerminalSessionPageProps {
  readonly sessionId: string;
}

/**
 * `/terminal/$sessionId`: one session, full window, with a minimal title bar.
 *
 * No fetch of the session's own metadata — the contract has no
 * `GET /api/terminals/:id`, and this is the pop-out target `window.open`
 * reaches with nothing but the id, so the title bar names the feature rather
 * than the session.
 *
 * @example
 * <TerminalSessionPage sessionId="term-1" />
 */
export function TerminalSessionPage({ sessionId }: TerminalSessionPageProps) {
  const { t } = useI18n();

  return (
    <div className="flex h-screen flex-col bg-canvas">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-stroke px-4">
        <TerminalSquare size={ICON_MD} className="text-fg-muted" />
        <span className="text-sm font-medium text-fg">{t.terminal.page.title}</span>
      </div>
      <div className="min-h-0 flex-1">
        <TerminalView sessionId={sessionId} />
      </div>
    </div>
  );
}
