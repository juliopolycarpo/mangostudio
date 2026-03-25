import { useState, useMemo, useCallback, createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { ptBR, en, type Messages, type Locale } from '@mangostudio/shared/i18n';

const LOCALE_STORAGE_KEY = 'mangostudio:locale';

const locales: Record<Locale, Messages> = {
  'pt-BR': ptBR,
  'en': en,
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
  const [locale, setLocaleState] = useState<Locale>(() => detectLocale());
  const t = useMemo(() => locales[locale], [locale]);

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale);
    localStorage.setItem(LOCALE_STORAGE_KEY, newLocale);
  }, []);

  return (
    <I18nContext.Provider value={{ t, locale, setLocale }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n deve ser usado dentro de I18nProvider');
  return ctx;
}
