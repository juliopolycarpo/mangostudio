import type { AdapterStrategy, ResourceFormat, ResourceKind } from '@mangostudio/shared/library';
import { createAgentStrategyAdapter } from './agent-strategy';
import { markdownToMdcAdapter, mdcToMarkdownAdapter } from './markdown-mdc';
import { dialectForMarkdownSubagentLocation } from './subagent-dialect';
import { createSubagentAdapter } from './subagent-frontmatter';
import type { AdapterCatalog, AdapterQuery, AdaptInput, AdaptResult, FormatAdapter } from './types';
import { createVerbatimAdapter } from './verbatim';

export type { AdapterCatalog } from './types';

export class FormatAdapterRegistry implements AdapterCatalog {
  private readonly adapters = new Map<string, FormatAdapter[]>();
  private readonly unsupported = new Set<string>();

  register(adapter: FormatAdapter): this {
    const key = adapterKey(adapter.kind, adapter.from, adapter.to);
    const current = this.adapters.get(key) ?? [];
    if (current.some((candidate) => candidate.strategy === adapter.strategy)) {
      throw new TypeError(`Duplicate ${adapter.strategy} adapter for ${key}.`);
    }
    current.push(adapter);
    this.adapters.set(key, current);
    this.unsupported.delete(key);
    return this;
  }

  markUnsupported(kind: ResourceKind, from: ResourceFormat, to: ResourceFormat): this {
    const key = adapterKey(kind, from, to);
    if (!this.adapters.has(key)) this.unsupported.add(key);
    return this;
  }

  strategiesFor(query: AdapterQuery): readonly AdapterStrategy[] {
    let adapters = this.adapters.get(adapterKey(query.kind, query.from, query.to)) ?? [];
    const sourceDialect = dialectForMarkdownSubagentLocation(query.sourceLocationId);
    const targetDialect = dialectForMarkdownSubagentLocation(query.targetLocationId);
    if (
      query.kind === 'subagent' &&
      query.from === 'markdown-frontmatter' &&
      query.to === 'markdown-frontmatter' &&
      sourceDialect &&
      targetDialect
    ) {
      adapters =
        sourceDialect === targetDialect
          ? adapters.filter((adapter) => adapter.strategy === 'verbatim')
          : adapters.filter((adapter) => adapter.strategy === 'mechanical');
    }
    const hasDeterministicStrategy = adapters.some((adapter) => adapter.strategy !== 'agent');
    return rankAdapterStrategies(
      adapters.flatMap((adapter) =>
        adapter.strategy === 'agent' &&
        (query.agentAvailable !== true ||
          (hasDeterministicStrategy && query.agentRequested !== true))
          ? []
          : [adapter.strategy]
      )
    ).available;
  }

  adapt(input: AdaptInput, strategy: AdapterStrategy): Promise<AdaptResult> {
    const adapter = (this.adapters.get(adapterKey(input.kind, input.from, input.to)) ?? []).find(
      (candidate) => candidate.strategy === strategy
    );
    if (!adapter) {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'unsupported-adapter',
          message: `No ${strategy} adapter supports ${input.kind} ${input.from} → ${input.to}.`,
        },
      });
    }
    return Promise.resolve(adapter.adapt(input));
  }

  coverageFor(
    kind: ResourceKind,
    from: ResourceFormat,
    to: ResourceFormat
  ): 'supported' | 'unsupported' | 'missing' {
    const key = adapterKey(kind, from, to);
    if (this.adapters.has(key)) return 'supported';
    return this.unsupported.has(key) ? 'unsupported' : 'missing';
  }
}

const RESOURCE_KINDS: readonly ResourceKind[] = [
  'skill',
  'subagent',
  'instruction',
  'setting',
  'hook',
];
const RESOURCE_FORMATS: readonly ResourceFormat[] = [
  'markdown-plain',
  'markdown-frontmatter',
  'mdc',
  'toml-agent',
  'agent-profile-db',
  'json-settings',
  'toml-settings',
  'rules-dsl',
];

export function createDefaultAdapterRegistry(): FormatAdapterRegistry {
  const registry = new FormatAdapterRegistry();
  for (const kind of RESOURCE_KINDS) {
    for (const format of RESOURCE_FORMATS) registry.register(createVerbatimAdapter(kind, format));
  }

  registry.register(markdownToMdcAdapter).register(mdcToMarkdownAdapter);
  for (const from of ['markdown-frontmatter', 'toml-agent', 'agent-profile-db'] as const) {
    for (const to of ['markdown-frontmatter', 'toml-agent', 'agent-profile-db'] as const) {
      if (from !== to || from === 'markdown-frontmatter') {
        registry.register(createSubagentAdapter(from, to));
      }
    }
  }

  registry
    .register(createAgentStrategyAdapter('instruction', 'markdown-plain', 'rules-dsl'))
    .register(createAgentStrategyAdapter('instruction', 'rules-dsl', 'markdown-plain'))
    .markUnsupported('setting', 'json-settings', 'toml-settings')
    .markUnsupported('setting', 'toml-settings', 'json-settings')
    .markUnsupported('hook', 'json-settings', 'rules-dsl')
    .markUnsupported('hook', 'rules-dsl', 'json-settings');
  return registry;
}

export const defaultAdapterRegistry = createDefaultAdapterRegistry();

/** Most faithful first; duplicates never skew recommendation. */
export function rankAdapterStrategies(strategies: readonly AdapterStrategy[]): {
  readonly available: AdapterStrategy[];
  readonly recommended?: AdapterStrategy;
} {
  const offered = new Set(strategies);
  const available = (['verbatim', 'mechanical', 'agent'] as const).filter((strategy) =>
    offered.has(strategy)
  );
  const [recommended] = available;
  return { available, ...(recommended !== undefined && { recommended }) };
}

function adapterKey(kind: ResourceKind, from: ResourceFormat, to: ResourceFormat): string {
  return `${kind}\0${from}\0${to}`;
}
