import { en, type Locale, type Messages, ptBR } from '@mangostudio/shared/i18n';
import type { ReactNode } from 'react';
import { createContext, use, useCallback, useMemo, useState } from 'react';

const LOCALE_STORAGE_KEY = 'mangostudio:locale';

const locales: Record<Locale, Messages> = {
  'pt-BR': ptBR,
  en: en,
};

function detectLocale(): Locale {
  const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
  if (stored === 'pt-BR' || stored === 'en') return stored;
  if (navigator.language.startsWith('pt')) return 'pt-BR';
  return 'en';
}

interface I18nContextValue {
  t: Messages;
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(() => detectLocale());
  const t = useMemo(() => locales[locale], [locale]);

  const changeLocale = useCallback((newLocale: Locale) => {
    setLocale(newLocale);
    localStorage.setItem(LOCALE_STORAGE_KEY, newLocale);
  }, []);

  return <I18nContext value={{ t, locale, setLocale: changeLocale }}>{children}</I18nContext>;
}

export function useI18n(): I18nContextValue {
  const ctx = use(I18nContext);
  if (!ctx) throw new Error('useI18n deve ser usado dentro de I18nProvider');
  return ctx;
}
