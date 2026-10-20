import { isDeprecatedProvider } from '@mangostudio/shared/provider-settings';
import type { ProviderType } from '@mangostudio/shared/types';
import {
  Database,
  Eye,
  EyeOff,
  FileCode,
  LoaderCircle,
  LogIn,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useI18n } from '@/hooks/use-i18n';
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
const PROVIDER_OPTIONS: { id: ProviderType }[] = (
  [
    { id: 'gemini' },
    { id: 'openai' },
    { id: 'openai-compatible' },
    { id: 'anthropic' },
    { id: 'deepseek' },
    { id: 'cursor' },
    { id: 'chatgpt' },
  ] satisfies { id: ProviderType }[]
).filter(({ id }) => !isDeprecatedProvider(id));

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
      icon: <ShieldCheck size={16} />,
      desc: s.sources.bunSecretsDesc,
    },
    {
      id: 'config-file' as const,
      label: s.sources.configFile,
      icon: <FileCode size={16} />,
      desc: s.sources.configFileDesc,
    },
    {
      id: 'environment' as const,
      label: s.sources.envFile,
      icon: <Database size={16} />,
      desc: s.sources.envFileDesc,
    },
  ];

  const handleChatGptSignIn = () => {
    const popup = window.open('about:blank', '_blank');
    void chatGptOAuth.start({ name: form.name, popup });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-scrim animate-in fade-in duration-200">
      <div className="bg-surface w-full max-w-lg rounded-3xl p-5 sm:p-8 shadow-2xl border border-stroke flex flex-col max-h-[90vh] sm:max-h-[85vh]">
        <div className="space-y-2 mb-5 sm:mb-6">
          <h3 className="text-xl font-bold text-fg">{s.addModalTitle}</h3>
          <p className="text-sm text-fg-muted">
            {isChatGpt ? s.chatgptAddModalDescription : s.addModalDescription}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto hide-scrollbar pr-1 space-y-4 min-h-0">
          {/* Provider selector */}
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-fg-muted">{s.providerLabel}</span>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {PROVIDER_OPTIONS.map(({ id }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setForm({
                      ...form,
                      provider: id,
                      apiKey: id === 'chatgpt' ? '' : form.apiKey,
                      source: id === 'chatgpt' ? 'bun-secrets' : form.source,
                      baseUrl: id === 'openai-compatible' || id === 'deepseek' ? form.baseUrl : '',
                    });
                  }}
                  className={`min-h-11 py-2.5 px-3 rounded-xl border text-xs sm:text-sm font-semibold text-center leading-snug transition-all ${
                    form.provider === id
                      ? 'bg-accent-subtle border-accent text-accent-fg'
                      : 'bg-control border-stroke text-fg hover:border-stroke'
                  }`}
                >
                  {t.providers[id]}
                </button>
              ))}
            </div>
          </div>

          <Input
            id="connector-name"
            label={s.nameLabel}
            type="text"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder={s.namePlaceholder}
          />

          {isChatGpt ? (
            <div className="rounded-2xl border border-stroke bg-control p-4 space-y-3">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 rounded-xl bg-accent-subtle p-2 text-accent-fg">
                  <LogIn size={18} />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-bold text-fg">{s.chatgptOAuthTitle}</p>
                  <p className="text-xs leading-relaxed text-fg-muted">
                    {s.chatgptOAuthDescription}
                  </p>
                </div>
              </div>

              {chatGptOAuth.isWaiting ? (
                <div className="rounded-xl border border-accent bg-accent-subtle p-3 space-y-2">
                  <p className="text-xs font-bold text-accent-fg">{s.chatgptWaitingTitle}</p>
                  <p className="text-xs leading-relaxed text-fg-muted">
                    {s.chatgptWaitingDescription}
                  </p>
                  <p className="text-[11px] leading-relaxed text-fg-subtle">
                    {s.chatgptRemoteAccessHint}
                  </p>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void chatGptOAuth.cancel()}
                    className="w-full"
                  >
                    {s.chatgptCancelSignIn}
                  </Button>
                </div>
              ) : null}

              {chatGptOAuth.error ? (
                <div className="flex items-start gap-2 rounded-xl border border-danger bg-danger-subtle p-3 text-xs text-danger">
                  <TriangleAlert size={15} className="mt-0.5 shrink-0" />
                  <span>{chatGptOAuth.error}</span>
                </div>
              ) : null}
            </div>
          ) : null}

          {!isChatGpt &&
            (form.provider === 'openai-compatible' || form.provider === 'deepseek') && (
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
              <div className="flex flex-col gap-1">
                <Input
                  id="connector-organization-id"
                  label={s.organizationIdLabel}
                  type="text"
                  value={form.organizationId}
                  onChange={(e) => setForm({ ...form, organizationId: e.target.value })}
                  placeholder={s.organizationIdPlaceholder}
                />
                <p className="text-[10px] text-fg-subtle ml-1">{s.organizationIdHelper}</p>
              </div>
              <div className="flex flex-col gap-1">
                <Input
                  id="connector-project-id"
                  label={s.projectIdLabel}
                  type="text"
                  value={form.projectId}
                  onChange={(e) => setForm({ ...form, projectId: e.target.value })}
                  placeholder={s.projectIdPlaceholder}
                />
                <p className="text-[10px] text-fg-subtle ml-1">{s.projectIdHelper}</p>
              </div>
            </>
          )}

          {!isChatGpt && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="connector-apikey" className="text-sm font-medium text-fg-muted">
                {s.apiKeyLabel}
              </label>
              <div className="flex gap-2">
                <input
                  id="connector-apikey"
                  type={showKey ? 'text' : 'password'}
                  value={form.apiKey}
                  onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                  className="
                  flex-1 rounded-xl px-4 py-2.5 text-sm
                  bg-surface text-fg
                  border border-stroke
                  placeholder:text-fg-subtle
                  focus:outline-none focus:border-focus focus:ring-1 focus:ring-focus
                  transition-colors
                "
                  placeholder={s.apiKeyPlaceholder}
                />
                <Button
                  variant="secondary"
                  size="md"
                  onClick={() => setShowKey(!showKey)}
                  className="px-3"
                  type="button"
                >
                  {showKey ? <EyeOff size={18} /> : <Eye size={18} />}
                </Button>
              </div>
            </div>
          )}

          {!isChatGpt && (
            <div className="space-y-3">
              <span className="text-xs font-bold text-fg-muted uppercase ml-1">
                {s.saveToLabel}
              </span>
              <div className="grid grid-cols-1 gap-2">
                {sourceOptions.map((src) => (
                  <button
                    key={src.id}
                    type="button"
                    onClick={() => setForm({ ...form, source: src.id })}
                    className={`flex items-start gap-4 p-4 rounded-2xl border text-left transition-all ${
                      form.source === src.id
                        ? 'bg-accent-subtle border-accent text-accent-fg'
                        : 'bg-control border-stroke text-fg hover:border-stroke'
                    }`}
                  >
                    <div className="mt-1">{src.icon}</div>
                    <div className="space-y-0.5">
                      <div className="text-sm font-bold">{src.label}</div>
                      <div
                        className={`text-[10px] ${form.source === src.id ? 'text-accent-fg' : 'text-fg-muted'}`}
                      >
                        {src.desc}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {!isChatGpt && formError ? (
          <p className="mt-4 text-xs text-danger font-medium text-center shrink-0">{formError}</p>
        ) : null}

        <div className="flex gap-3 pt-4 sm:pt-5 shrink-0">
          <Button variant="secondary" onClick={onClose} className="flex-1">
            {s.cancelButton}
          </Button>
          <Button
            variant="primary"
            onClick={isChatGpt ? handleChatGptSignIn : onSubmit}
            loading={isChatGpt ? chatGptOAuth.isStarting : isSaving}
            disabled={isChatGpt ? chatGptOAuth.isBusy : isSaving}
            className="flex-1"
          >
            {isChatGpt ? (
              chatGptOAuth.isBusy ? (
                <>
                  <LoaderCircle size={16} className="animate-spin" />
                  {chatGptOAuth.isWaiting ? s.chatgptReauthenticating : s.chatgptSigningIn}
                </>
              ) : (
                <>
                  <LogIn size={16} />
                  {s.chatgptSignInButton}
                </>
              )
            ) : isSaving ? (
              <>
                <LoaderCircle size={16} className="animate-spin" />
                {s.validating}
              </>
            ) : (
              s.addConnectorButton
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
