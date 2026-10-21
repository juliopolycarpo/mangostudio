import { useCallback } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';

/**
 * The two forms of a counted message, keyed the way the dictionaries name them:
 * a `sessionsOne` / `sessionsOther` pair becomes
 * `{ one: labels.sessionsOne, other: labels.sessionsOther }`.
 *
 * Two keys rather than one template with a `(s)` suffix: the suffix reads as
 * unfinished in English, and in Portuguese it cannot agree an adjective or a
 * participle ("arquivo alterado", "arquivos alterados") with the noun.
 */
export interface PluralForms {
  readonly one: string;
  readonly other: string;
}

const pluralRules = new Map<string, Intl.PluralRules>();

/**
 * One rules object per locale, kept for the process: constructing one costs far
 * more than selecting with it, and the callers are list rows.
 */
function pluralRulesFor(locale: string): Intl.PluralRules {
  const cached = pluralRules.get(locale);
  if (cached) return cached;
  const rules = new Intl.PluralRules(locale);
  pluralRules.set(locale, rules);
  return rules;
}

/**
 * Picks the form for `count` in `locale` and fills it in.
 *
 * `Intl.PluralRules` decides which form, with every category that is not `one`
 * reading as the plural (`pt-BR` also has a `many` for millions, which the
 * plural covers). `{count}` is the number itself unless `params` supplies its
 * own, which is how a caller that groups digits ("10,826") keeps doing so.
 *
 * For code that has no hook to call — a formatter, a toast builder. A component
 * uses {@link usePlural}.
 *
 * // Usage: pluralMessage({ one: '{count} chat', other: '{count} chats' }, 3, 'en')
 */
export function pluralMessage(
  forms: PluralForms,
  count: number,
  locale: string,
  params: Record<string, string> = {}
): string {
  const form = pluralRulesFor(locale).select(count) === 'one' ? forms.one : forms.other;
  return formatMessage(form, { count: String(count), ...params });
}

/**
 * {@link pluralMessage} bound to the active locale, stable for as long as the
 * locale is, so it is safe in a dependency list.
 *
 * // Usage: const plural = usePlural(); plural({ one: l.sessionsOne, other: l.sessionsOther }, n)
 */
export function usePlural(): (
  forms: PluralForms,
  count: number,
  params?: Record<string, string>
) => string {
  const { locale } = useI18n();
  return useCallback(
    (forms, count, params) => pluralMessage(forms, count, locale, params),
    [locale]
  );
}
