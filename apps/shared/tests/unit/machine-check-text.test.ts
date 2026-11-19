/**
 * The doctor row contract: stable keys, text rendered from them in any
 * locale, and English for anything the reader cannot render.
 */

import { describe, expect, it } from 'bun:test';

import Value from 'typebox/value';

import { en, ptBR } from '../../src/i18n';
import {
  MACHINE_CHECK_PARAMS_MAX,
  type MachineCheck,
  MachineCheckSchema,
  resolveMachineCheckText,
} from '../../src/machine';
import {
  MACHINE_CHECK_TEMPLATES_EN,
  MACHINE_DOCTOR_TEMPLATES_EN,
  renderMachineCheckEnglish,
} from '../../src/machine/check-text-en';

const PLACEHOLDER = /\{(\w+)\}/g;

function placeholdersOf(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1] as string).sort();
}

const MISMATCH_ROW: MachineCheck = {
  label: 'Runtime binary',
  labelKey: 'core.label.runtimeBinary',
  status: 'warn',
  detail: 'v0.9.0 does not match hub v1.0.0; reinstall so both come from one release',
  detailKey: 'core.detail.runtimeBinaryMismatch',
  params: { version: '0.9.0', hubVersion: '1.0.0' },
};

/**
 * Every key the doctor's checks can attach to a row (the runtime findings are
 * keyed by their own codes, pinned by the findings schema). A key is a wire identifier a
 * newer or older peer may hold a different copy of, so renaming one is a
 * breaking change: add the new key and keep the old one until no supported
 * peer sends it. This list is the pin that makes a rename show up as a diff.
 */
const DOCTOR_KEYS = [
  'core.detail.authSecretInvalid',
  'core.detail.authSecretSet',
  'core.detail.buildStampClean',
  'core.detail.buildStampDirty',
  'core.detail.buildStampDirtyUnknown',
  'core.detail.checkoutBuildDiffers',
  'core.detail.configDefaults',
  'core.detail.configFile',
  'core.detail.databaseInMemory',
  'core.detail.databasePath',
  'core.detail.directoryNotWritable',
  'core.detail.directoryParentNotWritable',
  'core.detail.directoryWillBeCreated',
  'core.detail.directoryWritable',
  'core.detail.frontendBuildDiffers',
  'core.detail.frontendBuildMissing',
  'core.detail.frontendEmbeddedFiles',
  'core.detail.frontendEmbeddedInServer',
  'core.detail.frontendMissing',
  'core.detail.frontendPresent',
  'core.detail.instanceNotRunning',
  'core.detail.instanceRunning',
  'core.detail.instanceStale',
  'core.detail.runtimeBinaryMismatch',
  'core.detail.runtimeBinaryMissing',
  'core.detail.runtimeBinaryNoVersion',
  'core.detail.runtimeBinaryNoVersionUnknown',
  'core.detail.runtimeBinaryNotBuilt',
  'core.detail.runtimeBinaryOk',
  'core.detail.runtimeCacheEmpty',
  'core.detail.runtimeCacheVersions',
  'core.detail.runtimeDevelopment',
  'core.detail.runtimeSlotConfigured',
  'core.detail.runtimeSlotConfiguredVersion',
  'core.detail.runtimeSlotDenied',
  'core.detail.runtimeSlotDeniedVersion',
  'core.detail.runtimeSlotPending',
  'core.detail.runtimeSlotUnreadable',
  'core.detail.runtimeStandalone',
  'core.detail.serverBuildMissing',
  'core.detail.sshClientMissing',
  'core.detail.sshClientNoVersion',
  'core.detail.sshClientNoVersionUnknown',
  'core.detail.sshClientOk',
  'core.label.authSecret',
  'core.label.checkoutBuild',
  'core.label.config',
  'core.label.database',
  'core.label.frontend',
  'core.label.frontendBuild',
  'core.label.homeDirectory',
  'core.label.instance',
  'core.label.logsDirectory',
  'core.label.runDirectory',
  'core.label.runtime',
  'core.label.runtimeBinary',
  'core.label.runtimeCache',
  'core.label.runtimeSlot',
  'core.label.serverBuild',
  'core.label.sshClient',
  'install.label.installedVia',
  'install.detail.installedVia',
  'install.detail.installedViaLegacy',
  'update.label.update',
  'update.detail.disabled',
  'update.detail.skippedEnv',
  'update.detail.skippedDev',
  'update.detail.notChecked',
  'update.detail.checkFailed',
  'update.detail.available',
  'update.detail.availableUnnamed',
  'update.detail.upToDate',
  'cursor.label.connector',
  'cursor.detail.deprecated',
  'chatgpt.label.secrets',
  'chatgpt.label.tokens',
  'chatgpt.label.refresh',
  'chatgpt.label.port',
  'chatgpt.label.auth',
  'chatgpt.label.backend',
  'chatgpt.detail.secretStoreUnavailable',
  'chatgpt.detail.secretStoreCorrupted',
  'chatgpt.detail.secretStoreReachable',
  'chatgpt.detail.secretStoreWriteFailed',
  'chatgpt.detail.connectorError',
  'chatgpt.detail.tokensReauthRequired',
  'chatgpt.detail.tokensExpired',
  'chatgpt.detail.tokensValid',
  'chatgpt.detail.refreshSkipped',
  'chatgpt.detail.refreshRotated',
  'chatgpt.detail.refreshRejected',
  'chatgpt.detail.portFree',
  'chatgpt.detail.portInUse',
  'chatgpt.detail.endpointReachable',
  'chatgpt.detail.endpointFailed',
  'skills.label.config',
  'skills.label.mango',
  'skills.label.agents',
  'skills.label.claude',
  'skills.label.skill',
  'skills.detail.configFromDefault',
  'skills.detail.configFromToml',
  'skills.detail.configFromEnv',
  'skills.detail.sourceUnreadable',
  'skills.detail.sourceUnreadableDisabled',
  'skills.detail.sourceMissing',
  'skills.detail.sourceMissingDisabled',
  'skills.detail.sourceCount',
  'skills.detail.sourceCountDisabled',
  'skills.detail.invalid',
  'skills.detail.shadowed',
  'skills.detail.disabled',
  'skills.detail.precedenceUnverified',
  'mcp.label.probeNote',
  'mcp.label.server',
  'mcp.label.command',
  'mcp.label.probe',
  'mcp.label.tools',
  'mcp.detail.probeNote',
  'mcp.detail.serverEnabled',
  'mcp.detail.serverDisabled',
  'mcp.detail.commandMissing',
  'mcp.detail.commandMissingDisabled',
  'mcp.detail.commandFound',
  'mcp.detail.commandNotFound',
  'mcp.detail.commandNotFoundDisabled',
  'mcp.detail.probeResult',
  'mcp.detail.longToolNames',
] as const;

describe('doctor check keys', () => {
  it('keeps the wire keys the checks send stable', () => {
    expect(Object.keys(MACHINE_DOCTOR_TEMPLATES_EN).sort()).toEqual([...DOCTOR_KEYS].sort());
  });

  it('keeps a runtime finding code from colliding with a doctor key', () => {
    const doctorKeys = new Set(Object.keys(MACHINE_DOCTOR_TEMPLATES_EN));
    const clashes = Object.keys(en.environments.findings).filter((code) => doctorKeys.has(code));
    expect(clashes, '(finding codes that are also doctor keys)').toEqual([]);
  });

  it('has the same keys in English and Portuguese', () => {
    const portuguese = ptBR.environments.machine.doctor.checks;
    expect(Object.keys(portuguese).sort()).toEqual(
      Object.keys(en.environments.machine.doctor.checks).sort()
    );
  });

  it.each(Object.entries(MACHINE_DOCTOR_TEMPLATES_EN))(
    'uses the same placeholders in both languages for %s',
    (key, english) => {
      const portuguese = (ptBR.environments.machine.doctor.checks as Record<string, string>)[key];
      expect(
        `${key}: ${placeholdersOf(portuguese as string).join(',')}`,
        `(doctor template ${key}): expected the pt-BR placeholders to equal the English ones`
      ).toBe(`${key}: ${placeholdersOf(english).join(',')}`);
    }
  );
});

describe('resolveMachineCheckText', () => {
  it('renders a keyed row from the templates it is given', () => {
    const portuguese = ptBR.environments.machine.doctor.checks;

    expect(resolveMachineCheckText(MISMATCH_ROW, portuguese)).toEqual({
      label: 'Binário do runtime',
      detail:
        'v0.9.0 não corresponde ao hub v1.0.0; reinstale para que ambos venham da mesma versão',
    });
  });

  it('renders the dynamic part of a label from params', () => {
    const row: MachineCheck = {
      label: 'Runtime slot (remote)',
      labelKey: 'core.label.runtimeSlot',
      status: 'warn',
      detail: '',
      params: { slot: 'remote' },
    };

    expect(resolveMachineCheckText(row, ptBR.environments.machine.doctor.checks).label).toBe(
      'Slot do runtime (remote)'
    );
  });

  it('shows the row English for a key the templates do not have', () => {
    const fromNewerHub: MachineCheck = {
      label: 'Quantum flux',
      labelKey: 'core.label.quantumFlux',
      status: 'warn',
      detail: 'flux drifted by 3 units',
      detailKey: 'core.detail.quantumFlux',
      params: { units: '3' },
    };

    expect(resolveMachineCheckText(fromNewerHub, MACHINE_CHECK_TEMPLATES_EN)).toEqual({
      label: 'Quantum flux',
      detail: 'flux drifted by 3 units',
    });
  });

  it('falls back per field, so a known label keeps its translation beside an unknown detail', () => {
    const row: MachineCheck = {
      ...MISMATCH_ROW,
      detail: 'something only a newer hub says',
      detailKey: 'core.detail.notYetInThisBuild',
    };

    expect(resolveMachineCheckText(row, ptBR.environments.machine.doctor.checks)).toEqual({
      label: 'Binário do runtime',
      detail: 'something only a newer hub says',
    });
  });

  it('shows the row English when the row lacks a param its template needs', () => {
    const row: MachineCheck = { ...MISMATCH_ROW, params: { version: '0.9.0' } };

    const text = resolveMachineCheckText(row, ptBR.environments.machine.doctor.checks);

    expect(text.detail, `(detail for params ${JSON.stringify(row.params)})`).toBe(row.detail);
    expect(text.detail).not.toContain('{hubVersion}');
  });

  it('shows the row English for a row with no keys', () => {
    const legacy: MachineCheck = { label: 'ChatGPT secrets', status: 'ok', detail: 'reachable' };

    expect(resolveMachineCheckText(legacy, ptBR.environments.machine.doctor.checks)).toEqual({
      label: 'ChatGPT secrets',
      detail: 'reachable',
    });
  });

  it('does not resolve a key to something on the templates prototype', () => {
    const row: MachineCheck = {
      label: 'Safe',
      labelKey: 'constructor',
      status: 'ok',
      detail: 'safe detail',
      detailKey: '__proto__',
    };

    expect(resolveMachineCheckText(row, {})).toEqual({ label: 'Safe', detail: 'safe detail' });
  });

  it('renders an environments row from the finding sentence its detail key names', () => {
    const row: MachineCheck = {
      label: 'Node.js',
      labelKey: 'env.label.tool',
      status: 'warn',
      detail: 'Version 20.1.0 is superseded LTS and will stop receiving fixes.',
      detailKey: 'outdated-lts',
      params: { tool: 'Node.js', version: '20.1.0', ltsStatus: 'lts-superseded' },
    };
    const templates = { ...ptBR.environments.machine.doctor.checks, ...ptBR.environments.findings };

    expect(resolveMachineCheckText(row, templates, { ltsStatus: ptBR.environments.lts })).toEqual({
      label: 'Node.js',
      detail: 'A versão 20.1.0 está em LTS substituído e deixará de receber correções.',
    });
    expect(renderMachineCheckEnglish(row).detail).toBe(row.detail);
  });

  it('words a code param from the value labels, and passes an unknown code through', () => {
    const row: MachineCheck = {
      label: 'Node.js',
      status: 'warn',
      detail: 'x',
      detailKey: 'outdated-lts',
      params: { version: '20.1.0', ltsStatus: 'a-status-from-a-newer-hub' },
    };
    const templates = ptBR.environments.findings;

    expect(
      resolveMachineCheckText(row, templates, { ltsStatus: ptBR.environments.lts }).detail
    ).toBe('A versão 20.1.0 está em a-status-from-a-newer-hub e deixará de receber correções.');
  });

  it('puts a param value in as written, braces included', () => {
    const row: MachineCheck = {
      label: 'Runtime binary',
      labelKey: 'core.label.runtimeBinary',
      status: 'warn',
      detail: 'x',
      detailKey: 'core.detail.runtimeBinaryNoVersion',
      params: { path: '/opt/{rt}', reason: 'spawn {failed}' },
    };

    expect(renderMachineCheckEnglish(row).detail).toBe(
      '/opt/{rt} did not report a version (spawn {failed})'
    );
  });
});

describe('MachineCheckSchema', () => {
  it('accepts a row with no keys, as an older hub sends it', () => {
    expect(Value.Check(MachineCheckSchema, { label: 'Config', status: 'ok', detail: 'x' })).toBe(
      true
    );
  });

  it('accepts a keyed row', () => {
    expect(Value.Check(MachineCheckSchema, MISMATCH_ROW)).toBe(true);
  });

  it('rejects params that are not strings, so a template never gets an object', () => {
    expect(Value.Check(MachineCheckSchema, { ...MISMATCH_ROW, params: { version: 9 } })).toBe(
      false
    );
  });

  it('rejects more params than the cap', () => {
    const params = Object.fromEntries(
      Array.from({ length: MACHINE_CHECK_PARAMS_MAX + 1 }, (_, index) => [`p${index}`, 'v'])
    );

    expect(Value.Check(MachineCheckSchema, { ...MISMATCH_ROW, params })).toBe(false);
  });
});
