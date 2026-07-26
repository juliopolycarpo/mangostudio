import { Value } from '@sinclair/typebox/value';
import { type LibraryResourceRef, type ResourceKind, ResourceKindSchema } from './schemas';

export const LIBRARY_RESOURCE_SLUG_MAX_LENGTH = 128;

export function isValidResourceSlug(slug: string): boolean {
  return (
    slug.length > 0 &&
    slug.length <= LIBRARY_RESOURCE_SLUG_MAX_LENGTH &&
    !slug.startsWith('.') &&
    !slug.includes('..') &&
    !slug.includes('/') &&
    !slug.includes('\\')
  );
}

export function resourceKey(kind: ResourceKind, slug: string): string {
  if (!isValidResourceSlug(slug)) {
    throw new TypeError(`Invalid library resource slug: ${slug}`);
  }
  return `${kind}:${slug}`;
}

export function parseResourceKey(key: string): LibraryResourceRef | null {
  const separatorIndex = key.indexOf(':');
  if (separatorIndex === -1) return null;

  const kind = key.slice(0, separatorIndex);
  const slug = key.slice(separatorIndex + 1);
  if (!Value.Check(ResourceKindSchema, kind) || !isValidResourceSlug(slug)) return null;

  return { kind, slug };
}
