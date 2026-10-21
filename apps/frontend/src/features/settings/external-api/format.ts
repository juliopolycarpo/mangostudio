import { API_KEY_PREFIX, type ApiKeyScope, type ApiKeySummary } from '@mangostudio/shared/api-keys';
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

/**
 * Whether Better Auth's stored `start` tells keys apart. It stores the bare
 * prefix by default, which every key shares, so it identifies nothing.
 */
export function hasKeyHint(start: string | null): start is string {
  return Boolean(start) && start !== API_KEY_PREFIX;
}

/** Renders the stored key hint as a truncated prefix, or a dash when it identifies nothing. */
export function formatKeyHint(start: string | null): string {
  return hasKeyHint(start) ? `${start}…` : '—';
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
