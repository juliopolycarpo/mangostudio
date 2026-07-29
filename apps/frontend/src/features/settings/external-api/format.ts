import type { ApiKeyScope, ApiKeySummary } from '@mangostudio/shared/api-keys';
import type { Locale, Messages } from '@mangostudio/shared/i18n';

const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(locale: Locale): Intl.DateTimeFormat {
  const cached = dateFormatterCache.get(locale);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  dateFormatterCache.set(locale, formatter);
  return formatter;
}

/** Renders Better Auth's stored key hint as a truncated prefix. */
export function formatKeyHint(start: string | null): string {
  if (!start) return '—';
  return `${start}…`;
}

export function formatApiKeyDate(value: string | null, locale: Locale, emptyLabel: string): string {
  if (!value) return emptyLabel;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return emptyLabel;
  return dateFormatter(locale).format(date);
}

export function isKeyExpired(key: ApiKeySummary, now = Date.now()): boolean {
  if (!key.expiresAt) return false;
  const expiresAt = new Date(key.expiresAt).getTime();
  return !Number.isNaN(expiresAt) && expiresAt <= now;
}

export function isKeyActive(key: ApiKeySummary, now = Date.now()): boolean {
  return !isKeyExpired(key, now);
}

export function scopeLabel(t: Messages, scope: ApiKeyScope): string {
  return t.settings.externalApi.scope[scope];
}

export function scopeHint(t: Messages, scope: ApiKeyScope): string {
  return t.settings.externalApi.scopeHint[scope];
}

export function displayKeyName(t: Messages, name: string | null): string {
  return name?.trim() ? name : t.settings.externalApi.unnamed;
}
