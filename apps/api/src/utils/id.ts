/** Generates a stable unique ID based on current time + random suffix. */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
