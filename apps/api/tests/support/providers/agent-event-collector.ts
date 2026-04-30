import type { AgentEvent } from '../../../src/services/providers/types';

/**
 * Drains an async iterable of AgentEvents into a plain array.
 *
 * @param source - Provider generator to consume.
 * @returns All yielded events in order.
 */
export async function collectAgentEvents(source: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of source) {
    events.push(event);
  }
  return events;
}
