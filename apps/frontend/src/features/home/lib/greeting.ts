/**
 * Which of the three greetings the hub opens with.
 *
 * Local hours on purpose: the greeting is about the user's morning, not the
 * hub's. Kept pure so the boundaries can be asserted without freezing a clock.
 */

export type GreetingSlot = 'morning' | 'afternoon' | 'evening';

/**
 * // Usage: greetingSlot(new Date()) === 'morning'
 */
export function greetingSlot(date: Date): GreetingSlot {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  return 'evening';
}
