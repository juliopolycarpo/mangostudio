function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === 'string');
}

export function parseStringArray(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return isStringArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
