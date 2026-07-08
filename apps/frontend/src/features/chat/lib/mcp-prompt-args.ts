/**
 * Pure helpers for the MCP prompt argument form: serialize form values to the
 * `prompts/get` arguments record and flatten a resolved prompt for insertion
 * into the composer input.
 */

import type { GetMcpPromptResponse, McpPromptArgument } from '@mangostudio/shared/mcp';

/**
 * Builds the arguments record from form values: trimmed, empty values dropped,
 * unknown keys ignored. Returns undefined when nothing was provided so no-arg
 * prompts send no arguments field at all.
 */
export function serializeMcpPromptArguments(
  descriptors: ReadonlyArray<McpPromptArgument>,
  values: Record<string, string>
): Record<string, string> | undefined {
  const serialized: Record<string, string> = {};
  for (const descriptor of descriptors) {
    const value = (values[descriptor.name] ?? '').trim();
    if (value) serialized[descriptor.name] = value;
  }
  return Object.keys(serialized).length > 0 ? serialized : undefined;
}

/** Names of required arguments the form has not filled in yet. */
export function missingRequiredMcpArguments(
  descriptors: ReadonlyArray<McpPromptArgument>,
  values: Record<string, string>
): string[] {
  return descriptors
    .filter((descriptor) => descriptor.required && !(values[descriptor.name] ?? '').trim())
    .map((descriptor) => descriptor.name);
}

/** Joins the resolved prompt's message texts into plain composer text. */
export function flattenMcpPromptText(response: GetMcpPromptResponse): string {
  return response.messages
    .map((message) => message.text)
    .filter((text) => text.length > 0)
    .join('\n\n');
}
