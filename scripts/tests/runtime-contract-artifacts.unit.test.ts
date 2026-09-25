import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PINNED_GITHUB_GRAPHQL_DOCUMENTS } from '@mangostudio/shared/github';
import {
  ARTIFACT_DIR,
  CATALOG_SCHEMA_URL,
  CONTRACT_ARTIFACTS,
  type ContractArtifact,
  renderArtifact,
  renderArtifacts,
} from '../runtime-contract/artifacts';
import { assertCatalogValid } from '../runtime-contract/validate';

const ROOT_DIR = join(import.meta.dir, '..', '..');

interface CatalogMethod {
  readonly name: string;
  readonly params: Record<string, unknown>;
  readonly result: Record<string, unknown>;
  readonly capabilities?: readonly string[];
}

interface CatalogDocument {
  readonly name: string;
  readonly version: string;
  readonly methods: readonly CatalogMethod[];
  readonly events?: ReadonlyArray<{ readonly topic: string }>;
  readonly capabilities?: Record<string, unknown>;
}

function renderedCatalog(): CatalogDocument {
  const text = renderArtifacts().get(`${ARTIFACT_DIR}/catalog.json`);
  if (text === undefined) throw new Error('renderArtifacts() produced no catalog.json.');
  return JSON.parse(text) as CatalogDocument;
}

function artifactByName(name: string): ContractArtifact {
  const artifact = CONTRACT_ARTIFACTS.find((entry) => entry.name === name);
  if (!artifact) throw new Error(`No artifact named ${name}.`);
  return artifact;
}

describe('runtime contract artifacts', () => {
  test('every artifact renders byte-identically twice', () => {
    for (const artifact of CONTRACT_ARTIFACTS) {
      expect(renderArtifact(artifact)).toBe(renderArtifact(artifact));
    }
  });

  test('every artifact matches the file committed beside the contract', () => {
    for (const [path, expected] of renderArtifacts()) {
      expect(readFileSync(join(ROOT_DIR, path), 'utf8')).toBe(expected);
    }
  });

  test('the catalog validates against the published protocol schema', async () => {
    await expect(assertCatalogValid(renderArtifacts())).resolves.toBeUndefined();
  });

  test('the hub catalog declares only hub.workspace.authorize, with closed shapes', () => {
    const text = renderArtifacts().get(`${ARTIFACT_DIR}/hub-catalog.json`);
    if (text === undefined) throw new Error('renderArtifacts() produced no hub-catalog.json.');
    const hub = JSON.parse(text) as CatalogDocument;
    expect(hub.name).toBe('mangostudio.hub');
    expect(hub.methods.map((method) => method.name)).toEqual(['hub.workspace.authorize']);
    for (const method of hub.methods) {
      expect(method.params.additionalProperties).toBe(false);
      expect(method.result.additionalProperties).toBe(false);
    }
  });

  test('a hub catalog the published schema refuses fails validation, naming the file', async () => {
    const artifacts = renderArtifacts();
    artifacts.set(`${ARTIFACT_DIR}/hub-catalog.json`, JSON.stringify({ name: 'mangostudio.hub' }));
    await expect(assertCatalogValid(artifacts)).rejects.toThrow(/hub-catalog\.json/);
  });

  test('the catalog names itself and points at the schema it satisfies', () => {
    const catalog = renderedCatalog();
    expect(catalog.name).toBe('mangostudio.runtime');
    expect(JSON.parse(renderArtifact(artifactByName('catalog.json'))).$schema).toBe(
      CATALOG_SCHEMA_URL
    );
  });

  /**
   * The point of the whole exercise. A catalog whose methods carry
   * `{ "type": "object" }` is byte-stable, validates, and tells a peer in
   * another language nothing at all — so "the file exists" is not the
   * assertion worth making about it.
   */
  test('no method describes its payloads as a bare object', () => {
    const bare = renderedCatalog()
      .methods.flatMap((method) => [
        { name: `${method.name} params`, schema: method.params },
        { name: `${method.name} result`, schema: method.result },
      ])
      .filter(({ schema }) => Object.keys(schema).length === 1 && schema.type === 'object')
      .map(({ name }) => name);

    expect(bare).toEqual([]);
  });

  /**
   * Health must answer regardless of consent, and terminal.close must still
   * terminate an existing PTY after shell consent has been withdrawn.
   */
  test('every method declares a capability list, with health and terminal cleanup ungated', () => {
    const withoutList = renderedCatalog()
      .methods.filter((method) => method.capabilities === undefined)
      .map((method) => method.name);
    expect(withoutList).toEqual([]);

    const ungated = renderedCatalog()
      .methods.filter((method) => (method.capabilities ?? []).length === 0)
      .map((method) => method.name);
    expect(ungated).toEqual(['terminal.close', 'runtime.health']);
  });

  test('the catalog carries the events and the manifest a peer negotiates with', () => {
    const catalog = renderedCatalog();
    expect(
      catalog.events
        ?.map((event) => event.topic)
        .slice()
        .sort()
    ).toEqual([
      'external-agent.event',
      'install.output',
      'mcp.elicitation',
      'mcp.session',
      'runtime.heartbeat',
      'terminal.output',
    ]);
    expect(catalog.capabilities?.type).toBe('object');
  });

  test('the string contracts a peer cannot derive are emitted verbatim', () => {
    const strings = JSON.parse(renderArtifact(artifactByName('strings.json')));
    expect(strings.setupPendingSignature).toBe('runtime setup is pending on this machine');
    expect(strings.updateExitCode).toBe(75);
    expect(strings.pairingTokenPrefix).toBe('mrt_');
    expect(strings.binding).toEqual({
      header: 'x-mangostudio-hub-binding',
      length: 64,
      alreadyBoundCloseCode: 4423,
      alreadyBoundReason: 'runtime already bound to another environment',
    });
    expect(strings.githubGraphqlDocuments).toEqual(PINNED_GITHUB_GRAPHQL_DOCUMENTS);
    expect(strings.runtimeHome.slots).toEqual(['host', 'wsl', 'remote']);
    expect(strings.errors.serviceErrorKinds).toContain('consent_denied');
  });
});
