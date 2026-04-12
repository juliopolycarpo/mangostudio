import type { ProviderType } from '@mangostudio/shared';
import { Eye, EyeOff, LoaderCircle, ShieldCheck, FileCode, Database } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useI18n } from '@/hooks/use-i18n';
import type { useConnectorForm } from '../hooks/use-connector-form';

const PROVIDER_OPTIONS: { id: ProviderType }[] = [
  { id: 'gemini' },
  { id: 'openai' },
  { id: 'openai-compatible' },
  { id: 'anthropic' },
];

type FormHook = ReturnType<typeof useConnectorForm>;

interface AddConnectorModalProps {
  form: FormHook['form'];
  setForm: FormHook['setForm'];
  isSaving: boolean;
  formError: string | null;
  showKey: boolean;
  setShowKey: (v: boolean) => void;
  onSubmit: () => void;
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
  onClose,
}: AddConnectorModalProps) {
  const { t } = useI18n();
  const s = t.settings.connectors;

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-surface-container-high w-full max-w-md rounded-3xl p-8 shadow-2xl border border-outline-variant/20 space-y-6">
        <div className="space-y-2">
          <h3 className="text-xl font-bold text-on-surface">{s.addModalTitle}</h3>
          <p className="text-sm text-on-surface-variant/70">{s.addModalDescription}</p>
        </div>

        <div className="space-y-4">
          {/* Provider selector */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-on-surface-variant">{s.providerLabel}</label>
            <div className="grid grid-cols-4 gap-2">
              {PROVIDER_OPTIONS.map(({ id }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() =>
                    setForm({
                      ...form,
                      provider: id,
                      baseUrl: id === 'openai-compatible' ? form.baseUrl : '',
                    })
                  }
                  className={`py-2 px-3 rounded-xl border text-xs font-bold text-center transition-all ${
                    form.provider === id
                      ? 'bg-primary/10 border-primary text-primary'
                      : 'bg-surface-container-lowest border-outline-variant/10 text-on-surface hover:border-outline-variant/30'
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

          {form.provider === 'openai-compatible' && (
            <Input
              id="connector-baseurl"
              label={s.baseUrlLabel}
              type="text"
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              placeholder={s.baseUrlPlaceholder}
            />
          )}

          {form.provider === 'openai' && (
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
                <p className="text-[10px] text-on-surface-variant/50 ml-1">
                  {s.organizationIdHelper}
                </p>
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
                <p className="text-[10px] text-on-surface-variant/50 ml-1">{s.projectIdHelper}</p>
              </div>
            </>
          )}

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="connector-apikey"
              className="text-sm font-medium text-on-surface-variant"
            >
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
                  bg-surface-container-high text-on-surface
                  border border-outline-variant/20
                  placeholder:text-on-surface/30
                  focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20
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

          <div className="space-y-3">
            <label className="text-xs font-bold text-on-surface-variant uppercase ml-1">
              {s.saveToLabel}
            </label>
            <div className="grid grid-cols-1 gap-2">
              {sourceOptions.map((src) => (
                <button
                  key={src.id}
                  type="button"
                  onClick={() => setForm({ ...form, source: src.id })}
                  className={`flex items-start gap-4 p-4 rounded-2xl border text-left transition-all ${
                    form.source === src.id
                      ? 'bg-primary/10 border-primary text-primary'
                      : 'bg-surface-container-lowest border-outline-variant/10 text-on-surface hover:border-outline-variant/30'
                  }`}
                >
                  <div className="mt-1">{src.icon}</div>
                  <div className="space-y-0.5">
                    <div className="text-sm font-bold">{src.label}</div>
                    <div
                      className={`text-[10px] ${form.source === src.id ? 'text-primary/70' : 'text-on-surface-variant/60'}`}
                    >
                      {src.desc}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>

        {formError && <p className="text-xs text-error font-medium text-center">{formError}</p>}

        <div className="flex gap-3">
          <Button variant="secondary" onClick={onClose} className="flex-1">
            {s.cancelButton}
          </Button>
          <Button
            variant="primary"
            onClick={onSubmit}
            loading={isSaving}
            disabled={isSaving}
            className="flex-1"
          >
            {isSaving ? (
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
