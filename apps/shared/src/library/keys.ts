import { Value } from '@sinclair/typebox/value';
import {
  LIBRARY_RESOURCE_SLUG_MAX_LENGTH,
  LIBRARY_RESOURCE_SLUG_PATTERN,
  type LibraryResourceRef,
  type ResourceKind,
  ResourceKindSchema,
} from './schemas';

const SLUG_PATTERN = new RegExp(LIBRARY_RESOURCE_SLUG_PATTERN);

export function isValidResourceSlug(slug: string): boolean {
  return slug.length <= LIBRARY_RESOURCE_SLUG_MAX_LENGTH && SLUG_PATTERN.test(slug);
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
