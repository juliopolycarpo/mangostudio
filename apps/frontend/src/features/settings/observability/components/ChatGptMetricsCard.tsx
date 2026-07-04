import type { Connector } from '@mangostudio/shared';
import { Card } from '@/components/ui/Card';
import { ChatGptResetCreditAction } from '@/features/settings/connectors/components/ChatGptResetCreditAction';
import { ChatGptUsageHistoryPanel } from '@/features/settings/connectors/components/ChatGptUsageHistoryPanel';
import { ChatGptUsageMeter } from '@/features/settings/connectors/components/ChatGptUsageMeter';
import { ChatGptUsageStatsPanel } from '@/features/settings/connectors/components/ChatGptUsageStatsPanel';
import { formatPlan } from '@/features/settings/connectors/lib/format-plan';
import { useI18n } from '@/hooks/use-i18n';

interface ChatGptMetricsCardProps {
  connector: Connector;
  /** Called after a redeem attempt so the caller can refresh connector usage. */
  onRedeemed: () => void | Promise<void>;
}

/**
 * Full ChatGPT account usage panel for the metrics page: identity header, the
 * session/weekly quota meter, the reset-credit redeem action, and the expanded
 * usage-history and account-stats panels that used to be collapsed on the
 * connector pill.
 */
export function ChatGptMetricsCard({ connector: c, onRedeemed }: ChatGptMetricsCardProps) {
  const { t } = useI18n();
  const s = t.settings.connectors;
  const account = c.accountLabel ?? c.maskedSuffix ?? s.chatgptAccountUnknown;
  const planLabel = formatPlan(c.planType, s);

  return (
    <Card variant="solid" className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-semibold text-on-surface">{c.name}</h3>
          <span className="rounded-full border border-outline-variant/20 bg-surface-container-high px-2 py-0.5 text-[10px] text-on-surface-variant">
            {s.chatgptPlanBadge.replace('{plan}', planLabel)}
          </span>
        </div>
        <span className="text-xs text-on-surface-variant/70">
          {s.chatgptSignedInAs.replace('{account}', account)}
        </span>
      </div>

      {c.usage ? (
        <>
          <ChatGptUsageMeter usage={c.usage} />
          <ChatGptResetCreditAction connector={c} onRedeemed={onRedeemed} />
        </>
      ) : (
        <p className="text-sm text-on-surface-variant/60">{t.settings.metrics.chatgptUsageEmpty}</p>
      )}

      <ChatGptUsageHistoryPanel connectorId={c.id} />
      <ChatGptUsageStatsPanel connectorId={c.id} />
    </Card>
  );
}
