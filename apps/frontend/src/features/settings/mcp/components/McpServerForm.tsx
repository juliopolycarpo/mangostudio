/**
 * Add/edit modal form for an MCP server. Fields switch on transport; only the
 * active transport's fields are submitted. Server-side TypeBox schemas remain
 * the source of truth — API validation errors surface through the caller.
 */

import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments/values';
import type { McpServer, McpTransport } from '@mangostudio/shared/mcp';
import { type FormEvent, useState } from 'react';
import { SettingsField } from '@/components/settings/SettingsField';
import { SettingsSegmented } from '@/components/settings/SettingsSegmented';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Toggle } from '@/components/ui/Toggle';
import { useEnvironmentEntitiesQuery } from '@/features/environments/queries';
import { useI18n } from '@/hooks/use-i18n';
import {
  createEmptyFormState,
  formStateFromServer,
  type McpServerFormErrors,
  type McpServerFormState,
  validateFormState,
} from '../lib/server-form';
import { EntryList } from './EntryList';
import { KeyValueListField } from './KeyValueListField';

interface McpServerFormProps {
  /** Present when editing; absent when adding. */
  server?: McpServer;
  isSaving: boolean;
  /** Error surfaced from the API after a failed save. */
  submitError: string | null;
  onSubmit: (state: McpServerFormState) => void;
  onClose: () => void;
}

const TRANSPORTS: McpTransport[] = ['stdio', 'http'];

export function McpServerForm({
  server,
  isSaving,
  submitError,
  onSubmit,
  onClose,
}: McpServerFormProps) {
  const { t } = useI18n();
  const s = t.settings.mcp;
  const environments = useEnvironmentEntitiesQuery();

  const [state, setState] = useState<McpServerFormState>(() =>
    server ? formStateFromServer(server) : createEmptyFormState()
  );
  const [errors, setErrors] = useState<McpServerFormErrors>({});

  const patch = (updates: Partial<McpServerFormState>) =>
    setState((prev) => ({ ...prev, ...updates }));

  const selectedEnvironmentName =
    environments.data?.find((environment) => environment.id === state.environmentId)?.name ??
    state.environmentId;
  /**
   * Stored secrets count as much as newly typed ones: moving an existing
   * server is exactly the moment its saved credentials start travelling.
   * Only the active transport's secret bundle travels.
   */
  const carriesSecrets =
    state.environmentId !== LOCAL_ENVIRONMENT_ID &&
    (state.transport === 'stdio'
      ? state.secretEnv.some((entry) => entry.key.trim().length > 0) ||
        (server?.secretEnvNames.length ?? 0) > 0
      : state.headers.some((entry) => entry.key.trim().length > 0) ||
        (server?.headerNames.length ?? 0) > 0);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const validationErrors = validateFormState(state, s);
    setErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) return;
    onSubmit(state);
  };

  const environmentLoading = environments.isPending && !environments.data;

  return (
    <Dialog
      title={server ? s.editServer : s.addServer}
      onSubmit={handleSubmit}
      notice={submitError ? <Callout tone="danger">{submitError}</Callout> : undefined}
      closeDisabled={isSaving}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            {s.cancelButton}
          </Button>
          <Button type="submit" variant="primary" loading={isSaving}>
            {isSaving ? s.savingButton : s.saveButton}
          </Button>
        </>
      }
    >
      <Input
        id="mcp-server-name"
        label={s.nameLabel}
        value={state.name}
        onChange={(e) => patch({ name: e.target.value })}
        placeholder={s.namePlaceholder}
        error={errors.name}
      />

      <SettingsField label={s.slugLabel} htmlFor="mcp-server-slug" hint={s.slugHint}>
        <Input
          id="mcp-server-slug"
          value={state.slug}
          onChange={(e) => patch({ slug: e.target.value })}
          placeholder={s.slugPlaceholder}
          error={errors.slug}
        />
      </SettingsField>

      <SettingsField label={s.transportLabel}>
        <SettingsSegmented
          ariaLabel={s.transportLabel}
          value={state.transport}
          options={TRANSPORTS.map((transport) => ({
            value: transport,
            label: s.transports[transport],
          }))}
          onChange={(transport) => patch({ transport })}
        />
      </SettingsField>

      <SettingsField
        label={s.environmentLabel}
        htmlFor="mcp-server-environment"
        hint={s.environmentHint}
      >
        <Select
          id="mcp-server-environment"
          value={state.environmentId}
          onChange={(environmentId) => patch({ environmentId })}
          ariaLabel={s.environmentLabel}
          disabled={environmentLoading}
          options={[
            ...(environmentLoading
              ? [{ value: state.environmentId, label: s.environmentsLoading }]
              : []),
            // An environment that vanished (or is not readable) still has to
            // render, or editing an unrelated field would silently rehome
            // the server to whichever option happened to come first.
            ...(environments.data?.some((environment) => environment.id === state.environmentId) ===
            false
              ? [{ value: state.environmentId, label: state.environmentId }]
              : []),
            ...(environments.data ?? []).map((environment) => ({
              value: environment.id,
              label: environment.name,
              disabled: !environment.enabled,
            })),
          ]}
        />
      </SettingsField>
      {carriesSecrets ? (
        <Callout tone="warning" title={s.remoteSecretNoticeTitle}>
          {s.remoteSecretNotice.replace('{environment}', selectedEnvironmentName)}
        </Callout>
      ) : null}

      {state.transport === 'stdio' ? (
        <>
          <Callout tone="warning">{s.stdioTrustWarning}</Callout>

          <Input
            id="mcp-server-command"
            label={s.commandLabel}
            value={state.command}
            onChange={(e) => patch({ command: e.target.value })}
            placeholder={s.commandPlaceholder}
            error={errors.command}
          />

          <EntryList
            label={s.argsLabel}
            addLabel={s.addArgument}
            emptyLabel={s.noArguments}
            entries={state.args}
            onAdd={() => patch({ args: [...state.args, ''] })}
            onRemove={(index) => patch({ args: state.args.filter((_, i) => i !== index) })}
            renderEntry={(arg, index) => (
              <div className="min-w-0 flex-1">
                <Input
                  value={arg}
                  onChange={(e) =>
                    patch({
                      args: state.args.map((a, i) => (i === index ? e.target.value : a)),
                    })
                  }
                  placeholder={s.argPlaceholder}
                  aria-label={`${s.argsLabel} ${index + 1}`}
                />
              </div>
            )}
          />

          <KeyValueListField
            label={s.envLabel}
            hint={s.envHint}
            addLabel={s.addVariable}
            emptyLabel={s.noVariables}
            entries={state.env}
            onChange={(env) => patch({ env })}
          />

          {server && <StoredNames names={server.secretEnvNames} srLabel={s.storedSecretEnvValue} />}

          <KeyValueListField
            label={s.secretEnvLabel}
            hint={s.secretEnvHint}
            addLabel={s.addSecretVariable}
            emptyLabel={s.noSecretVariables}
            entries={state.secretEnv}
            onChange={(secretEnv) => patch({ secretEnv })}
            secretValues
          />
        </>
      ) : (
        <>
          <Input
            id="mcp-server-url"
            label={s.urlLabel}
            value={state.url}
            onChange={(e) => patch({ url: e.target.value })}
            placeholder={s.urlPlaceholder}
            error={errors.url}
          />

          {server && <StoredNames names={server.headerNames} srLabel={s.storedHeaderValue} />}

          <KeyValueListField
            label={s.headersLabel}
            hint={s.headersHint}
            addLabel={s.addHeader}
            emptyLabel={s.noHeaders}
            entries={state.headers}
            onChange={(headers) => patch({ headers })}
            secretValues
          />
        </>
      )}

      <SettingsField label={s.timeoutLabel} htmlFor="mcp-server-timeout" hint={s.timeoutHint}>
        <Input
          id="mcp-server-timeout"
          type="number"
          min={1}
          value={state.timeoutMs}
          onChange={(e) => patch({ timeoutMs: e.target.value })}
          className="w-32 text-center"
        />
      </SettingsField>

      <Toggle
        id="mcp-server-enabled"
        label={state.enabled ? s.enabledLabel : s.disabledLabel}
        checked={state.enabled}
        onChange={(e) => patch({ enabled: e.target.checked })}
      />
    </Dialog>
  );
}

interface StoredNamesProps {
  readonly names: readonly string[];
  /** Said to a screen reader after each name, in place of the masked dots. */
  readonly srLabel: string;
}

/** The names of write-only values already saved: the value itself never comes back. */
function StoredNames({ names, srLabel }: StoredNamesProps) {
  if (names.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {names.map((name) => (
        <Badge key={name}>
          <span className="font-medium text-fg">{name}</span>
          <span aria-hidden="true">••••••</span>
          <span className="sr-only">{srLabel}</span>
        </Badge>
      ))}
    </div>
  );
}
