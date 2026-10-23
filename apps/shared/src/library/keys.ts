import {
  isResourceKind,
  LIBRARY_RESOURCE_SLUG_MAX_LENGTH,
  LIBRARY_RESOURCE_SLUG_PATTERN,
  type ResourceKind,
} from './choices';
import type { LibraryResourceRef } from './schemas';

const SLUG_PATTERN = new RegExp(LIBRARY_RESOURCE_SLUG_PATTERN);

/**
 * Whether a slug fits the path-safe library shape and length bound.
 * @example
 * isValidResourceSlug('shared-resource'); // true
 */
export function isValidResourceSlug(slug: string): boolean {
  return slug.length <= LIBRARY_RESOURCE_SLUG_MAX_LENGTH && SLUG_PATTERN.test(slug);
}

/**
 * Format a resource identity, refusing an unsafe slug before it becomes a path segment.
 * @example
 * resourceKey('skill', 'shared-resource'); // 'skill:shared-resource'
 */
export function resourceKey(kind: ResourceKind, slug: string): string {
  if (!isValidResourceSlug(slug)) {
    throw new TypeError(`Invalid library resource slug: ${slug}`);
  }
  return `${kind}:${slug}`;
}

/**
 * Decode a closed resource kind and safe slug, or return null for an invalid key.
 * @example
 * parseResourceKey('skill:shared-resource'); // { kind: 'skill', slug: 'shared-resource' }
 */
export function parseResourceKey(key: string): LibraryResourceRef | null {
  const separatorIndex = key.indexOf(':');
  if (separatorIndex === -1) return null;

  const kind = key.slice(0, separatorIndex);
  const slug = key.slice(separatorIndex + 1);
  if (!isResourceKind(kind) || !isValidResourceSlug(slug)) return null;

  return { kind, slug };
}
