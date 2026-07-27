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

const DIALECT_FIELDS: Readonly<Record<SubagentDialect, ReadonlySet<string>>> = {
  claude: new Set([
    'name',
    'description',
    'tools',
    'model',
    'disallowedTools',
    'permissionMode',
    'mcpServers',
    'hooks',
    'maxTurns',
    'skills',
    'initialPrompt',
    'memory',
    'effort',
    'background',
    'isolation',
    'color',
  ]),
  codex: new Set([
    'name',
    'description',
    'developer_instructions',
    'model',
    'model_reasoning_effort',
    'sandbox_mode',
    'mcp_servers',
    'skills',
  ]),
  cursor: new Set(['name', 'description', 'model', 'readonly', 'is_background']),
  mangostudio: new Set([
    'name',
    'description',
    'role',
    'model',
    'tools',
    'subagents',
    'thinkingEnabled',
    'reasoningEffort',
    'maxToolIterations',
  ]),
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
    const notes = droppedFieldNotes(parsed, targetDialect);
    return {
      ok: true,
      content: renderDescriptor(parsed.descriptor, targetDialect),
      notes,
      requiresReview: false,
      lossy: notes.length > 0,
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
  if (descriptor.model) lines.push(`model: ${JSON.stringify(descriptor.model)}`);
  if ((dialect === 'claude' || dialect === 'mangostudio') && descriptor.tools?.length) {
    lines.push('tools:', ...descriptor.tools.map((tool) => `  - ${JSON.stringify(tool)}`));
  }
  lines.push('---', '', descriptor.body);
  return lines.join('\n');
}

function droppedFieldNotes(parsed: ParsedSubagent, targetDialect: SubagentDialect): AdaptNote[] {
  const targetFields = DIALECT_FIELDS[targetDialect];
  const dropped = new Set(
    [...parsed.sourceFields].filter(
      (field) => field !== 'developer_instructions' && !targetFields.has(field)
    )
  );
  if (parsed.descriptor.tools?.length && !targetFields.has('tools')) dropped.add('tools');

  return [...dropped].sort(compareText).map((field) => ({
    code: 'field-dropped',
    field,
    message: `${field} is not supported by ${displayDialect(targetDialect)} and was dropped`,
  }));
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
