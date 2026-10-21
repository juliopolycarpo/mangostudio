import type { ExternalAgentRemedy } from '@mangostudio/shared/external-agents';
import { Link } from '@tanstack/react-router';
import { buttonClassName } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { cn } from '@/lib/utils';

interface ExternalRemedyLinkProps {
  /** The remedy the hub or the discovery descriptor named. */
  remedy: ExternalAgentRemedy;
  className?: string;
}

/**
 * The link for the two remedies MangoStudio can act on, install and update.
 *
 * It points at the environments surface that already owns the install and update recipes rather
 * than growing a second affordance, and it runs nothing: the user follows the link and acts there.
 * Every other remedy kind has its own control (the sign-in command) or nothing to offer, so this
 * renders nothing for them.
 *
 * It is a `subtle` small button drawn on a router link, like any other row action, so
 * its height, padding and hover are the system's rather than a hand-built copy of them.
 *
 * // Usage: <ExternalRemedyLink remedy={descriptor.remedy} />
 */
export function ExternalRemedyLink({ remedy, className }: ExternalRemedyLinkProps) {
  const { t } = useI18n();
  if (remedy.kind !== 'install' && remedy.kind !== 'update') return null;
  return (
    <div className={className}>
      <Link
        to="/environments/agents"
        className={cn(buttonClassName('subtle', 'sm'), 'w-fit text-accent-fg')}
      >
        {t.externalAgents.remedy[remedy.kind]}
      </Link>
    </div>
  );
}
