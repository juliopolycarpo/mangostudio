import type { Messages } from '@mangostudio/shared/i18n';
import { useI18n } from '@/hooks/use-i18n';
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
 * The hub's opening line. The name is the accent-coloured half, as in the
 * reference design — it is the only place the surface addresses the user
 * directly, so it earns the one warm colour on the screen.
 */
export function GreetingHeader({ userName, subtitle, now = new Date() }: GreetingHeaderProps) {
  const { t } = useI18n();
  const labels = t.home.greeting;
  const slot = greetingSlot(now);
  const name = userName.trim();

  return (
    <header className="space-y-1.5">
      <h2 className="font-headline text-2xl font-bold tracking-tight text-on-surface sm:text-3xl">
        {name ? (
          // Split rather than interpolated into one string so the name can be
          // coloured without the locale file carrying markup.
          <GreetingWithName template={labels[NAMED_KEY[slot]]} name={name} />
        ) : (
          labels[ANONYMOUS_KEY[slot]]
        )}
      </h2>
      <p className="text-sm text-on-surface-variant">{subtitle ?? labels.subtitle}</p>
    </header>
  );
}

const NAME_PLACEHOLDER = '{name}';

/**
 * Renders `Good morning, {name}.` with only the substituted name in the accent
 * colour, whatever side of the sentence the locale puts it on. A locale that
 * left the placeholder out reads as a plain greeting rather than as a crash.
 */
function GreetingWithName({ template, name }: { template: string; name: string }) {
  const at = template.indexOf(NAME_PLACEHOLDER);
  if (at === -1) return <>{template}</>;
  return (
    <>
      {template.slice(0, at)}
      <span className="text-primary">{name}</span>
      {template.slice(at + NAME_PLACEHOLDER.length)}
    </>
  );
}
