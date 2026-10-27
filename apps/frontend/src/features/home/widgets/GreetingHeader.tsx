import type { Messages } from '@mangostudio/shared/i18n';

import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';

import { type GreetingSlot, greetingSlot } from '../lib/greeting';

interface GreetingHeaderProps {
  /** First name from the session. Empty when the account has no display name. */
  userName: string;
  /**
   * The line under the greeting. Defaults to the chat hub's, which promises
   * what *this workspace* looks like; the dashboard promises something wider
   * and says so rather than repeating a sentence that names one folder.
   */
  subtitle?: string;
  /** Injectable for tests; the greeting is a wall-clock read otherwise. */
  now?: Date;
}

const NAMED_KEY: Readonly<Record<GreetingSlot, keyof Messages['home']['greeting']>> = {
  morning: 'morning',
  afternoon: 'afternoon',
  evening: 'evening',
};

const ANONYMOUS_KEY: Readonly<Record<GreetingSlot, keyof Messages['home']['greeting']>> = {
  morning: 'morningAnonymous',
  afternoon: 'afternoonAnonymous',
  evening: 'eveningAnonymous',
};

/**
 * The hub's opening line, and the one `text-headline` on its screen. The name
 * is part of the sentence and reads in the same colour: the accent marks the
 * primary action and the current item, and a greeting is neither.
 */
export function GreetingHeader({ userName, subtitle, now = new Date() }: GreetingHeaderProps) {
  const { t } = useI18n();
  const labels = t.home.greeting;
  const slot = greetingSlot(now);
  const name = userName.trim();

  return (
    <header className="space-y-1">
      <h2 className="text-headline font-semibold text-fg">
        {name ? formatMessage(labels[NAMED_KEY[slot]], { name }) : labels[ANONYMOUS_KEY[slot]]}
      </h2>
      <p className="text-sm text-fg-muted">{subtitle ?? labels.subtitle}</p>
    </header>
  );
}
