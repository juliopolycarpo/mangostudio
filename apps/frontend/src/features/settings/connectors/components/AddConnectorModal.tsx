import { isDeprecatedProvider } from '@mangostudio/shared/provider-settings';
import type { ProviderType } from '@mangostudio/shared/types';
import { Database, Eye, EyeOff, FileCode, LogIn, ShieldCheck } from 'lucide-react';
import { PickOneRow } from '@/components/settings/PickOneRow';
import { SettingsField } from '@/components/settings/SettingsField';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD } from '@/lib/icon-sizes';
import { useChatGptOAuth } from '../hooks/use-chatgpt-oauth';
import type { useConnectorForm } from '../hooks/use-connector-form';

/**
 * Providers a new connector can be created for.
 *
 * Deprecated ones are filtered out rather than rendered disabled: a dead button
 * in a picker invites a click that has no answer, and the connectors people
 * already have say what happened on their own card. The server refuses them
 * too — this list is the courtesy, not the rule.
 */
const PROVIDERS: readonly ProviderType[] = (
  [
    'gemini',
    'openai',
    'openai-compatible',
    'anthropic',
    'deepseek',
    'cursor',
    'chatgpt',
  ] satisfies ProviderType[]
).filter((id) => !isDeprecatedProvider(id));

type FormHook = ReturnType<typeof useConnectorForm>;

interface AddConnectorModalProps {
  form: FormHook['form'];
  setForm: FormHook['setForm'];
  isSaving: boolean;
  formError: string | null;
  showKey: boolean;
  setShowKey: (v: boolean) => void;
  onSubmit: () => void;
  onOAuthSuccess: () => void | Promise<void>;
  onClose: () => void;
}

export function AddConnectorModal({
  form,
  setForm,
  isSaving,
  formError,
  showKey,
  setShowKey,
  onSubmit,
  onOAuthSuccess,
  onClose,
}: AddConnectorModalProps) {
  const { t } = useI18n();
  const s = t.settings.connectors;
  const isChatGpt = form.provider === 'chatgpt';
  const chatGptOAuth = useChatGptOAuth({
    messages: s,
    onSuccess: onOAuthSuccess,
  });

  const sourceOptions = [
    {
      id: 'bun-secrets' as const,
      label: s.sources.bunSecrets,
      icon: <ShieldCheck size={ICON_MD} />,
      desc: s.sources.bunSecretsDesc,
    },
    {
      id: 'config-file' as const,
      label: s.sources.configFile,
      icon: <FileCode size={ICON_MD} />,
      desc: s.sources.configFileDesc,
    },
    {
      id: 'environment' as const,
      label: s.sources.envFile,
      icon: <Database size={ICON_MD} />,
      desc: s.sources.envFileDesc,
    },
  ];

  const handleChatGptSignIn = () => {
    const popup = window.open('about:blank', '_blank');
    void chatGptOAuth.start({ name: form.name, popup });
  };

  const selectProvider = (id: ProviderType) => {
    setForm({
      ...form,
      provider: id,
      apiKey: id === 'chatgpt' ? '' : form.apiKey,
      source: id === 'chatgpt' ? 'bun-secrets' : form.source,
      baseUrl: id === 'openai-compatible' || id === 'deepseek' ? form.baseUrl : '',
    });
  };

  // The button's own spinner (`loading`) says it is working; the label says what
  // it is waiting for.
  const submitLabel = isChatGpt ? (
    chatGptOAuth.isBusy ? (
      chatGptOAuth.isWaiting ? (
        s.chatgptReauthenticating
      ) : (
        s.chatgptSigningIn
      )
    ) : (
      <>
        <LogIn size={ICON_MD} />
        {s.chatgptSignInButton}
      </>
    )
  ) : isSaving ? (
    s.validating
  ) : (
    s.addConnectorButton
  );

  return (
    <Dialog
      title={s.addModalTitle}
      description={isChatGpt ? s.chatgptAddModalDescription : s.addModalDescription}
      onClose={onClose}
      notice={!isChatGpt && formError ? <Callout tone="danger">{formError}</Callout> : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {s.cancelButton}
          </Button>
          <Button
            variant="primary"
            onClick={isChatGpt ? handleChatGptSignIn : onSubmit}
            loading={isChatGpt ? chatGptOAuth.isBusy : isSaving}
          >
            {submitLabel}
          </Button>
        </>
      }
    >
      {/* Six providers and counting: a list this long is a `Select`, which also
          keeps the dialog's first control one line tall however many are added. */}
      <SettingsField label={s.providerLabel} htmlFor="connector-provider">
        <Select
          id="connector-provider"
          ariaLabel={s.providerLabel}
          value={form.provider}
          options={PROVIDERS.map((id) => ({ value: id, label: t.providers[id] }))}
          onChange={(value) => selectProvider(value as ProviderType)}
        />
      </SettingsField>

      <Input
        id="connector-name"
        label={s.nameLabel}
        type="text"
        value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })}
        placeholder={s.namePlaceholder}
      />

      {isChatGpt ? (
        <div className="space-y-3">
          <Callout tone="neutral" icon={<LogIn size={ICON_MD} />} title={s.chatgptOAuthTitle}>
            {s.chatgptOAuthDescription}
          </Callout>

          {chatGptOAuth.isWaiting ? (
            <Callout tone="info" title={s.chatgptWaitingTitle}>
              <p>{s.chatgptWaitingDescription}</p>
              <p className="text-xs">{s.chatgptRemoteAccessHint}</p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void chatGptOAuth.cancel()}
                className="mt-2"
              >
                {s.chatgptCancelSignIn}
              </Button>
            </Callout>
          ) : null}

          {chatGptOAuth.error ? <Callout tone="danger">{chatGptOAuth.error}</Callout> : null}
        </div>
      ) : null}

      {!isChatGpt && (form.provider === 'openai-compatible' || form.provider === 'deepseek') && (
        <Input
          id="connector-baseurl"
          label={s.baseUrlLabel}
          type="text"
          value={form.baseUrl}
          onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
          placeholder={
            form.provider === 'deepseek' ? s.deepseekBaseUrlPlaceholder : s.baseUrlPlaceholder
          }
        />
      )}

      {!isChatGpt && form.provider === 'openai' && (
        <>
          <div className="space-y-1">
            <Input
              id="connector-organization-id"
              label={s.organizationIdLabel}
              type="text"
              value={form.organizationId}
              onChange={(e) => setForm({ ...form, organizationId: e.target.value })}
              placeholder={s.organizationIdPlaceholder}
            />
            <p className="text-xs text-fg-muted">{s.organizationIdHelper}</p>
          </div>
          <div className="space-y-1">
            <Input
              id="connector-project-id"
              label={s.projectIdLabel}
              type="text"
              value={form.projectId}
              onChange={(e) => setForm({ ...form, projectId: e.target.value })}
              placeholder={s.projectIdPlaceholder}
            />
            <p className="text-xs text-fg-muted">{s.projectIdHelper}</p>
          </div>
        </>
      )}

      {!isChatGpt && (
        <div className="space-y-1">
          <label htmlFor="connector-apikey" className="block text-sm font-medium text-fg">
            {s.apiKeyLabel}
          </label>
          <div className="flex gap-2">
            <div className="min-w-0 flex-1">
              <Input
                id="connector-apikey"
                type={showKey ? 'text' : 'password'}
                value={form.apiKey}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                placeholder={s.apiKeyPlaceholder}
              />
            </div>
            <Button
              type="button"
              variant="secondary"
              size="icon"
              aria-label={showKey ? s.hideApiKey : s.showApiKey}
              title={showKey ? s.hideApiKey : s.showApiKey}
              aria-pressed={showKey}
              onClick={() => setShowKey(!showKey)}
            >
              {showKey ? <EyeOff size={ICON_MD} /> : <Eye size={ICON_MD} />}
            </Button>
          </div>
        </div>
      )}

      {!isChatGpt && (
        <SettingsField label={s.saveToLabel}>
          <div role="radiogroup" aria-label={s.saveToLabel} className="grid grid-cols-1 gap-2">
            {sourceOptions.map((src) => (
              <PickOneRow
                key={src.id}
                name="connector-source"
                checked={form.source === src.id}
                onSelect={() => setForm({ ...form, source: src.id })}
                icon={src.icon}
                title={src.label}
                description={src.desc}
              />
            ))}
          </div>
        </SettingsField>
      )}
    </Dialog>
  );
}
