import type {
  AdaptNote,
  LibraryLocationId,
  ResourceFormat,
  SubagentDescriptor,
} from '@mangostudio/shared/library';
import { type MarkdownFrontmatter, parseMarkdownFrontmatter } from '@mangostudio/shared/markdown';
import { parse as parseToml } from 'smol-toml';
import { extractFrontmatterBody, removeFrontmatterSeparator } from './frontmatter-framing';
import type { AdaptInput, AdaptResult, FormatAdapter } from './types';

type SubagentDialect = 'claude' | 'codex' | 'cursor' | 'mangostudio';

interface ParsedSubagent {
  readonly descriptor: SubagentDescriptor;
  readonly sourceFields: ReadonlySet<string>;
}

/**
 * What `renderDescriptor` actually writes for each dialect, not what the dialect
 * is capable of storing. Loss notes are derived from this set: a field the
 * destination understands but the renderer never emits — Claude's `skills` on
 * the way to Codex, say — is still lost, and reporting it as carried over would
 * make the adapter claim a fidelity it does not have.
 */
const RENDERED_FIELDS: Readonly<Record<SubagentDialect, ReadonlySet<string>>> = {
  claude: new Set(['name', 'description', 'model', 'tools']),
  codex: new Set(['name', 'description', 'model', 'developer_instructions']),
  cursor: new Set(['name', 'description', 'model']),
  mangostudio: new Set(['name', 'description', 'model', 'tools', 'role']),
};

export function createSubagentAdapter(from: ResourceFormat, to: ResourceFormat): FormatAdapter {
  return {
    kind: 'subagent',
    from,
    to,
    strategy: 'mechanical',
    lossy: true,
    adapt: async (input) => adaptSubagent(input),
  };
}

function adaptSubagent(input: AdaptInput): AdaptResult {
  try {
    const targetDialect = dialectFor(input.to, input.targetLocationId);
    const parsed = parseDescriptor(input.content, input.from);
    const notes = adaptationNotes(parsed, targetDialect);
    return {
      ok: true,
      content: renderDescriptor(parsed.descriptor, targetDialect),
      notes,
      requiresReview: false,
      // Only a dropped field loses information; supplying a required
      // destination default does not.
      lossy: notes.some((note) => note.code === 'field-dropped'),
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'invalid-source',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function parseDescriptor(content: string, format: ResourceFormat): ParsedSubagent {
  if (format === 'toml-agent') {
    const value = parseToml(content);
    const name = requiredString(value.name, 'name');
    const description = requiredString(value.description, 'description');
    const body = requiredBody(value.developer_instructions, 'developer_instructions');
    const model = optionalString(value.model);
    return {
      descriptor: { name, description, body, ...(model && { model }) },
      sourceFields: new Set(Object.keys(value)),
    };
  }

  const parsed = parseMarkdownFrontmatter(content);
  const body = extractFrontmatterBody(content);
  if (body === undefined) {
    throw new TypeError('Subagent markdown does not contain a complete frontmatter block.');
  }
  const name = requiredString(parsed.frontmatter.name, 'name');
  const description = requiredString(parsed.frontmatter.description, 'description');
  const tools = stringList(parsed.frontmatter.tools);
  const model = optionalString(parsed.frontmatter.model);
  return {
    descriptor: {
      name,
      description,
      body: removeFrontmatterSeparator(body),
      ...(tools.length > 0 && { tools }),
      ...(model && { model }),
    },
    sourceFields: new Set(Object.keys(parsed.frontmatter)),
  };
}

function renderDescriptor(descriptor: SubagentDescriptor, dialect: SubagentDialect): string {
  if (dialect === 'codex') {
    return [
      `name = ${JSON.stringify(descriptor.name)}`,
      `description = ${JSON.stringify(descriptor.description)}`,
      ...(descriptor.model ? [`model = ${JSON.stringify(descriptor.model)}`] : []),
      `developer_instructions = ${JSON.stringify(descriptor.body)}`,
      '',
    ].join('\n');
  }

  const lines = [
    '---',
    `name: ${JSON.stringify(descriptor.name)}`,
    `description: ${JSON.stringify(descriptor.description)}`,
  ];
  // MangoStudio reads its own agent markdown with `role` defaulting to
  // `primary`, so a subagent written without it would load as a primary agent.
  if (dialect === 'mangostudio') lines.push('role: subagent');
  if (descriptor.model) lines.push(`model: ${JSON.stringify(descriptor.model)}`);
  if ((dialect === 'claude' || dialect === 'mangostudio') && descriptor.tools?.length) {
    lines.push('tools:', ...descriptor.tools.map((tool) => `  - ${JSON.stringify(tool)}`));
  }
  lines.push('---', '', descriptor.body);
  return lines.join('\n');
}

function adaptationNotes(parsed: ParsedSubagent, targetDialect: SubagentDialect): AdaptNote[] {
  const renderedFields = RENDERED_FIELDS[targetDialect];
  const dropped = new Set(
    [...parsed.sourceFields].filter(
      (field) => field !== 'developer_instructions' && !renderedFields.has(field)
    )
  );
  if (parsed.descriptor.tools?.length && !renderedFields.has('tools')) dropped.add('tools');

  const notes: AdaptNote[] = [...dropped].sort(compareText).map((field) => ({
    code: 'field-dropped',
    field,
    message: `${field} is not carried into ${displayDialect(targetDialect)} and was dropped`,
  }));
  if (targetDialect === 'mangostudio' && !parsed.sourceFields.has('role')) {
    notes.push({
      code: 'metadata-added',
      field: 'role',
      message: 'role was set to subagent, which MangoStudio requires to load this as a subagent',
    });
  }
  return notes;
}

function dialectFor(format: ResourceFormat, locationId?: LibraryLocationId): SubagentDialect {
  if (format === 'toml-agent') return 'codex';
  if (format === 'agent-profile-db' || locationId === 'mango-agents') return 'mangostudio';
  if (locationId?.startsWith('cursor-')) return 'cursor';
  return 'claude';
}

function displayDialect(dialect: SubagentDialect): string {
  switch (dialect) {
    case 'claude':
      return 'Claude';
    case 'codex':
      return 'Codex';
    case 'cursor':
      return 'Cursor';
    case 'mangostudio':
      return 'MangoStudio';
  }
}

function requiredString(value: unknown, field: string): string {
  const resolved = optionalString(value);
  if (!resolved) throw new TypeError(`Subagent ${field} must be a non-empty string.`);
  return resolved;
}

function requiredBody(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`Subagent ${field} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringList(value: MarkdownFrontmatter[string]): readonly string[] {
  if (Array.isArray(value))
    return value
      .map(String)
      .map((item) => item.trim())
      .filter(Boolean);
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
