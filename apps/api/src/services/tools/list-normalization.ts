export interface PathListItem {
  path: string;
  enabled: boolean;
}

interface NormalizeArrayOptions {
  rejectInvalid?: boolean;
}

export function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return normalizeStringArray(value) ?? [];
  }
  if (typeof value === 'string') {
    return splitStringList(value);
  }
  return [];
}

export function normalizeStringArray(
  value: readonly unknown[],
  options: NormalizeArrayOptions = {}
): string[] | null {
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      if (options.rejectInvalid) return null;
      continue;
    }
    const trimmed = item.trim();
    if (trimmed.length > 0) {
      strings.push(trimmed);
    }
  }
  return strings;
}

export function normalizePathList(value: unknown): PathListItem[] {
  if (Array.isArray(value)) {
    const strings = normalizeStringArray(value, { rejectInvalid: true });
    if (strings) {
      return strings.map(toPathListItem);
    }
    return normalizePathItemArray(value) ?? [];
  }

  return normalizeStringList(value).map(toPathListItem);
}

export function normalizePathItemArray(
  value: readonly unknown[],
  options: NormalizeArrayOptions = {}
): PathListItem[] | null {
  const items: PathListItem[] = [];
  for (const raw of value) {
    if (!isPathItem(raw)) {
      if (options.rejectInvalid) return null;
      continue;
    }
    const trimmed = raw.path.trim();
    if (trimmed.length > 0) {
      items.push({ path: trimmed, enabled: raw.enabled });
    }
  }
  return items;
}

function splitStringList(value: string): string[] {
  return value
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function toPathListItem(path: string): PathListItem {
  return { path, enabled: true };
}

function isPathItem(value: unknown): value is PathListItem {
  return (
    typeof value === 'object' &&
    value !== null &&
    'path' in value &&
    typeof (value as Record<string, unknown>).path === 'string' &&
    'enabled' in value &&
    typeof (value as Record<string, unknown>).enabled === 'boolean'
  );
}
