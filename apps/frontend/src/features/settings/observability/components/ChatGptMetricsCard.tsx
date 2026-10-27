import type { Connector } from '@mangostudio/shared/connectors';

import { SettingsSection } from '@/components/settings/SettingsSection';
import { Badge } from '@/components/ui/Badge';
import { ChatGptResetCreditAction } from '@/features/settings/connectors/components/ChatGptResetCreditAction';
import { ChatGptResetCreditList } from '@/features/settings/connectors/components/ChatGptResetCreditList';
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
 * connector pill. The panels are divided by hairlines inside the one card.
 */
export function ChatGptMetricsCard({ connector: c, onRedeemed }: ChatGptMetricsCardProps) {
  const { t } = useI18n();
  const s = t.settings.connectors;
  const account = c.accountLabel ?? c.maskedSuffix ?? s.chatgptAccountUnknown;
  const planLabel = formatPlan(c.planType, s);

  return (
    <SettingsSection
      padded
      title={c.name}
      description={s.chatgptSignedInAs.replace('{account}', account)}
      action={<Badge>{s.chatgptPlanBadge.replace('{plan}', planLabel)}</Badge>}
    >
      {c.usage ? (
        <>
          <ChatGptUsageMeter usage={c.usage} />
          {c.usage.resetCredits?.credits && c.usage.resetCredits.credits.length > 0 && (
            <ChatGptResetCreditList credits={c.usage.resetCredits.credits} />
          )}
          <ChatGptResetCreditAction connector={c} onRedeemed={onRedeemed} />
        </>
      ) : (
        <p className="text-sm text-fg-muted">{t.settings.metrics.chatgptUsageEmpty}</p>
      )}

      <div className="border-t border-stroke pt-4">
        <ChatGptUsageHistoryPanel connectorId={c.id} />
      </div>
      <div className="border-t border-stroke pt-4">
        <ChatGptUsageStatsPanel connectorId={c.id} />
      </div>
    </SettingsSection>
  );
}
