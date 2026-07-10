import { describe, expect, test } from 'bun:test';

import { readText } from './support/read-text';

/** Slice a labeler config into the body of a single label section. */
function extractLabelSection(labeler: string, start: string, end: string): string {
  const startIdx = labeler.indexOf(start);
  if (startIdx < 0) return '';
  const bodyStart = startIdx + start.length;
  const endIdx = labeler.indexOf(end, bodyStart);
  return endIdx < 0 ? labeler.slice(bodyStart) : labeler.slice(bodyStart, endIdx);
}

describe('labeler coverage', () => {
  test('classifies scripts and test-only changes', () => {
    const labeler = readText('.github/labeler.yml');

    expect(labeler).toContain('"area: build":');
    expect(labeler).toContain('- "scripts/**"');
    expect(labeler).toContain('"type: test":');
    expect(labeler).toContain('- "**/*.test.ts"');
    expect(labeler).toContain('- "**/*.spec.ts"');
    expect(labeler).toContain('- "scripts/tests/**"');
    expect(labeler).toContain('- "tests/**"');
  });

  test('classifies root dependency and tooling changes so the verify gate passes', () => {
    const labeler = readText('.github/labeler.yml');

    // Dependabot's bun ecosystem opens PRs touching only these two files; both
    // must map to a label or the "Verify classification labels" gate fails.
    expect(labeler).toContain('- "package.json"');
    expect(labeler).toContain('- "bun.lock"');
    expect(labeler).toContain('- "Dockerfile*"');
    expect(labeler).toContain('- "playwright.config.ts"');
  });

  test('classifies repo-meta and .github changes so the verify gate passes', () => {
    const labeler = readText('.github/labeler.yml');

    expect(labeler).toContain('- "LICENSE"');
    expect(labeler).toContain('- ".github/**/*.md"');
    expect(labeler).toContain('- ".github/dependabot.yml"');
  });

  test('splits dependency bumps into a dedicated label', () => {
    const labeler = readText('.github/labeler.yml');

    // Dependabot bun PRs must be classified as dependency maintenance, not
    // conflated with product build work; see issue #381.
    expect(labeler).toContain('"type: dependencies":');
    const depsSection = extractLabelSection(labeler, '"type: dependencies":', '"type: test":');
    expect(depsSection).toContain('- "package.json"');
    expect(depsSection).toContain('- "bun.lock"');
  });

  test('keeps build manifests out of the dependencies label', () => {
    const labeler = readText('.github/labeler.yml');

    // The dependency label is a clean split from area: build, so build-only
    // manifests must not also be classified as dependency updates.
    const depsSection = extractLabelSection(labeler, '"type: dependencies":', '"type: test":');
    expect(depsSection).not.toContain('tsconfig');
    expect(depsSection).not.toContain('Dockerfile');
    expect(depsSection).not.toContain('turbo.jsonc');
    expect(depsSection).not.toContain('cliff.toml');
  });

  test('classifies DevX tooling as area: tooling, not area: build', () => {
    const labeler = readText('.github/labeler.yml');

    expect(labeler).toContain('"area: tooling":');
    const toolingSection = extractLabelSection(labeler, '"area: tooling":', '"area: db":');
    expect(toolingSection).toContain('- "biome.json"');
    expect(toolingSection).toContain('- "dprint.json"');
    expect(toolingSection).toContain('- "lefthook.yml"');
    expect(toolingSection).toContain('- "opencode.json"');
    expect(toolingSection).toContain('- ".editorconfig"');
    expect(toolingSection).toContain('- ".gitattributes"');
    expect(toolingSection).toContain('- ".gitmessage"');
    expect(toolingSection).toContain('- ".gitignore"');
    expect(toolingSection).toContain('- ".claude/**"');

    const buildSection = extractLabelSection(labeler, '"area: build":', '"area: docs":');
    expect(buildSection).not.toContain('biome.json');
    expect(buildSection).not.toContain('dprint.json');
    expect(buildSection).not.toContain('lefthook.yml');
    expect(buildSection).not.toContain('opencode.json');
    expect(buildSection).not.toContain('.editorconfig');
    expect(buildSection).not.toContain('.gitattributes');
    expect(buildSection).not.toContain('.gitmessage');
    expect(buildSection).not.toContain('.gitignore');
  });

  test('classifies skills and MCP feature changes', () => {
    const labeler = readText('.github/labeler.yml');

    expect(labeler).toContain('"area: skills":');
    const skillsSection = extractLabelSection(labeler, '"area: skills":', '"area: mcp":');
    expect(skillsSection).toContain('- "apps/api/src/modules/skills/**"');
    expect(skillsSection).toContain('- "apps/frontend/src/features/settings/skills/**"');
    expect(skillsSection).toContain('- "apps/shared/src/skills/**"');

    expect(labeler).toContain('"area: mcp":');
    const mcpSection = extractLabelSection(labeler, '"area: mcp":', '"area: tooling":');
    expect(mcpSection).toContain('- "apps/api/src/services/mcp/**"');
    expect(mcpSection).toContain('- "apps/api/src/modules/mcp-servers/**"');
    expect(mcpSection).toContain('- "apps/frontend/src/features/settings/mcp/**"');
    expect(mcpSection).toContain('- "apps/shared/src/mcp/**"');
  });

  test('applies type: dependencies as a Dependabot auto-label for both ecosystems', () => {
    const dependabot = readText('.github/dependabot.yml');

    // One block per ecosystem; each must carry the auto-label so neither the
    // github-actions nor the bun ecosystem loses dependency classification.
    const ecosystemBlocks = dependabot.split('package-ecosystem:').slice(1);
    expect(ecosystemBlocks).toHaveLength(2);
    for (const block of ecosystemBlocks) {
      expect(block).toContain('"type: dependencies"');
    }
  });

  test('fails the labeler workflow when no classification label is applied', () => {
    const workflow = readText('.github/workflows/labeler.yml');

    expect(workflow).toContain('name: Verify classification labels');
    expect(workflow).toContain("name.startsWith('area: ')");
    expect(workflow).toContain("name.startsWith('type: ')");
    expect(workflow).toContain('No area: or type: label was applied');
  });

  test('reads applied labels from the labeler output, not a second API call', () => {
    const workflow = readText('.github/workflows/labeler.yml');

    expect(workflow).toContain('ALL_LABELS: $' + '{{ steps.label.outputs.all-labels }}');
    expect(workflow).not.toContain('listLabelsOnIssue');
    expect(workflow).not.toContain('issues: read');
  });

  test('documents that ownership routing belongs in auto-assign, not here', () => {
    const workflow = readText('.github/workflows/labeler.yml');

    expect(workflow).toContain('auto-assign.yml');
    expect(workflow).not.toContain('addAssignees');
    expect(workflow).not.toContain('requestReviewers');
  });
});
