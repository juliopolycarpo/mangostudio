import { describe, expect, it } from 'bun:test';
import * as EnvironmentValues from '@mangostudio/shared/environments/values';
import * as ExternalValues from '@mangostudio/shared/external-agents/values';
import * as GenerationValues from '@mangostudio/shared/generation/values';
import * as LibraryValues from '@mangostudio/shared/library/values';
import * as MachineLimits from '@mangostudio/shared/machine/limits';
import * as RuntimeValues from '@mangostudio/shared/runtime-home/values';
import Value from 'typebox/value';
import * as Environments from '../../src/environments';
import * as External from '../../src/external-agents';
import * as Generation from '../../src/generation';
import * as Library from '../../src/library';
import * as Machine from '../../src/machine';
import { RuntimeShellKindSchema as ManifestShellKinds } from '../../src/runtime-contract/manifest';
import { RuntimeShellKindSchema } from '../../src/runtime-contract/shell-kinds';
import * as Runtime from '../../src/runtime-home';

describe('lightweight browser values', () => {
  it('keeps environment identities, mount limits and toolchain keys canonical', () => {
    expect(EnvironmentValues.LOCAL_ENVIRONMENT_ID).toBe(Environments.LOCAL_ENVIRONMENT_ID);
    expect(EnvironmentValues.LOCAL_ENVIRONMENT_NAME).toBe(Environments.LOCAL_ENVIRONMENT_NAME);
    expect(EnvironmentValues.CONTAINER_MAX_MOUNTS).toBe(Environments.CONTAINER_MAX_MOUNTS);
    expect(EnvironmentValues.RuntimeIdSchema).toBe(Environments.RuntimeIdSchema);
    expect(EnvironmentValues.VersionManagerIdSchema).toBe(Environments.VersionManagerIdSchema);
    expect(Object.keys(Environments.ToolchainSelectionSchema.properties)).toEqual([
      ...EnvironmentValues.TOOLCHAIN_RUNTIME_IDS,
    ]);
    expect(
      Value.Check(Environments.EnvironmentIdSchema, EnvironmentValues.LOCAL_ENVIRONMENT_ID)
    ).toBe(true);
    for (const length of [
      EnvironmentValues.CONTAINER_MAX_MOUNTS,
      EnvironmentValues.CONTAINER_MAX_MOUNTS + 1,
    ]) {
      const config = {
        image: 'alpine',
        mounts: Array.from({ length }, (_, index) => ({
          hostPath: `/safe-${index}`,
          containerPath: `/data-${index}`,
        })),
      };
      expect(Value.Check(Environments.ContainerEnvironmentConfigSchema, config)).toBe(
        length === EnvironmentValues.CONTAINER_MAX_MOUNTS
      );
    }
  });

  it('shares the external-agent schema objects and every derived choice', () => {
    expect(ExternalValues.ExternalVendorIdSchema).toBe(External.ExternalVendorIdSchema);
    expect(ExternalValues.ExternalAgentRemedyKindSchema).toBe(
      External.ExternalAgentRemedyKindSchema
    );
    expect(ExternalValues.ExternalAgentRemedySchema).toBe(External.ExternalAgentRemedySchema);
    expect(ExternalValues.ExternalAgentTargetIdSchema).toBe(External.ExternalAgentTargetIdSchema);
    expect(ExternalValues.ExternalPermissionLevelSchema).toBe(
      External.ExternalPermissionLevelSchema
    );
    expect(ExternalValues.ExternalApprovalRoutingSchema).toBe(
      External.ExternalApprovalRoutingSchema
    );
    expect(ExternalValues.ExternalAgentUnavailableReasonSchema).toBe(
      External.ExternalAgentUnavailableReasonSchema
    );
    expect(ExternalValues.EXTERNAL_AGENT_TARGET_IDS).toEqual(['codex', 'cursor', 'claude']);
    expect(ExternalValues.EXTERNAL_PERMISSION_LEVELS).toEqual([
      'read-only',
      'default',
      'full-access',
    ]);
    expect(ExternalValues.EXTERNAL_APPROVAL_ROUTINGS).toEqual(['user', 'auto-review']);
    expect(ExternalValues.EXTERNAL_AGENT_UNAVAILABLE_REASONS).toEqual(
      External.ExternalAgentUnavailableReasonSchema.anyOf.map((member) => member.const)
    );
    for (const target of ExternalValues.EXTERNAL_AGENT_TARGET_IDS) {
      expect(ExternalValues.isExternalAgentTargetId(target)).toBe(true);
      expect(Value.Check(External.ExternalAgentTargetIdSchema, target)).toBe(true);
    }
    expect(ExternalValues.isExternalAgentTargetId('toString')).toBe(false);
  });

  it('retains external limits at the compatibility entrypoint', () => {
    expect(ExternalValues.EXTERNAL_ATTACHMENT_MAX_BYTES).toBe(
      External.EXTERNAL_ATTACHMENT_MAX_BYTES
    );
    expect(ExternalValues.EXTERNAL_TURN_MAX_ATTACHMENTS).toBe(
      External.EXTERNAL_TURN_MAX_ATTACHMENTS
    );
    expect(ExternalValues.EXTERNAL_ACCOUNT_LIMITS_STALE_MS).toBe(
      External.EXTERNAL_ACCOUNT_LIMITS_STALE_MS
    );
    expect(ExternalValues.EXTERNAL_COMMAND_CATALOG_MAX_ITEMS).toBe(
      External.EXTERNAL_COMMAND_CATALOG_MAX_ITEMS
    );
    expect(ExternalValues.EXTERNAL_NATIVE_SESSION_PAGE_LIMIT).toBe(
      External.EXTERNAL_NATIVE_SESSION_PAGE_LIMIT
    );
  });

  it('keeps runtime slots, capability keys and consent on their canonical schema', () => {
    expect(RuntimeValues.RuntimeSlotSchema).toBe(Runtime.RuntimeSlotSchema);
    expect(RuntimeValues.RuntimeCapabilityAllowSchema).toBe(Runtime.RuntimeCapabilityAllowSchema);
    expect(RuntimeValues.RUNTIME_SLOTS).toEqual(['host', 'wsl', 'remote']);
    expect(Object.keys(Runtime.RuntimeCapabilityAllowSchema.properties)).toEqual([
      ...RuntimeValues.RUNTIME_CAPABILITY_KEYS,
    ]);
    expect(RuntimeValues.RUNTIME_CONSENT_PRESETS).toBe(Runtime.RUNTIME_CONSENT_PRESETS);
    expect(RuntimeValues.RUNTIME_CONSENT_PRESETS.readonly.shell).toBe(false);
    expect(RuntimeValues.RUNTIME_CONSENT_PRESETS.readonly.externalAgents).toBe(false);
    expect(RuntimeValues.SHELL_TRUST_NOTICE).toBe(Runtime.SHELL_TRUST_NOTICE);
  });

  it('shares resource-kind schema and slug limits with the existing wire contract', () => {
    expect(LibraryValues.ResourceKindSchema).toBe(Library.ResourceKindSchema);
    expect(LibraryValues.LibraryTargetIdSchema).toBe(Library.LibraryTargetIdSchema);
    expect(LibraryValues.LibraryLocationIdSchema).toBe(Library.LibraryLocationIdSchema);
    expect(LibraryValues.LibraryScopeSchema).toBe(Library.LibraryScopeSchema);
    expect(LibraryValues.LIBRARY_SCOPES).toEqual(['home', 'workspace']);
    expect(LibraryValues.LibraryScopeSchema.anyOf.map((member) => member.const)).toEqual([
      ...LibraryValues.LIBRARY_SCOPES,
    ]);
    expect(LibraryValues.LIBRARY_RESOURCE_SLUG_MAX_LENGTH).toBe(
      Library.LIBRARY_RESOURCE_SLUG_MAX_LENGTH
    );
    expect(LibraryValues.LIBRARY_RESOURCE_SLUG_PATTERN).toBe(Library.LIBRARY_RESOURCE_SLUG_PATTERN);
    expect(LibraryValues.RESOURCE_KINDS).toEqual([
      'skill',
      'subagent',
      'command',
      'instruction',
      'setting',
      'hook',
    ]);
    for (const kind of LibraryValues.RESOURCE_KINDS) {
      expect(LibraryValues.isResourceKind(kind)).toBe(true);
      expect(
        LibraryValues.parseResourceKey(LibraryValues.resourceKey(kind, 'shared-resource'))
      ).toEqual({ kind, slug: 'shared-resource' });
    }
  });

  it('keeps the terminal shell union independent from the larger manifest', () => {
    expect(RuntimeShellKindSchema).toBe(ManifestShellKinds);
    expect(RuntimeShellKindSchema.anyOf.map((member) => member.const)).toEqual([
      'bash',
      'zsh',
      'powershell',
    ]);
  });

  it('keeps generation and machine limits at the compatibility entrypoints', () => {
    for (const name of [
      'GENERATION_CHAT_ID_MAX_LENGTH',
      'GENERATION_PROMPT_MAX_LENGTH',
      'GENERATION_SYSTEM_PROMPT_MAX_LENGTH',
      'GENERATION_MODEL_ID_MAX_LENGTH',
      'GENERATION_ATTACHMENT_IDS_MAX_ITEMS',
      'GENERATION_ATTACHMENT_ID_MAX_LENGTH',
      'GENERATION_REFERENCE_IMAGE_URL_MAX_LENGTH',
      'GENERATION_IMAGE_QUALITY_MAX_LENGTH',
      'GENERATION_THINKING_VISIBILITY_MAX_LENGTH',
    ] as const) {
      expect(GenerationValues[name]).toBe(Generation[name]);
    }
    expect(MachineLimits.MACHINE_LOG_TAIL_DEFAULT).toBe(Machine.MACHINE_LOG_TAIL_DEFAULT);
    expect(MachineLimits.MACHINE_LOG_TAIL_MAX).toBe(Machine.MACHINE_LOG_TAIL_MAX);
  });

  it.each(
    [
      '',
      'Skill',
      'skills',
      'toString',
      'constructor',
      '__proto__',
      null,
      undefined,
      0,
      true,
      {},
      ['skill'],
    ].map((value) => [value])
  )('rejects unsupported resource kind %j without weakening schema validation', (value) => {
    expect(LibraryValues.isResourceKind(value)).toBe(false);
    expect(Value.Check(Library.ResourceKindSchema, value)).toBe(false);
    if (typeof value === 'string')
      expect(LibraryValues.parseResourceKey(`${value}:item`)).toBeNull();
  });
});
