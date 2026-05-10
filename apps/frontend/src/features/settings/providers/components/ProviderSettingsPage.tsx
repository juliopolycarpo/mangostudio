/**
 * Provider settings detail page.
 * Shows runtime controls for a single provider based on its descriptor.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import type { UpdateProviderRuntimeSettingsBody } from '@mangostudio/shared/provider-settings';
import { useI18n } from '@/hooks/use-i18n';
import { useProviderSettings, useUpdateProviderSettings } from '../hooks/use-provider-settings';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { ReasoningSettingsSection } from './ReasoningSettingsSection';
import { ToolSettingsSection } from './ToolSettingsSection';
import { CacheSettingsSection } from './CacheSettingsSection';
import { ProviderAdvancedSection } from './ProviderAdvancedSection';

const PROVIDER_SETTINGS_AUTOSAVE_MS = 300;

function areProviderSettingsEqual(
  left: UpdateProviderRuntimeSettingsBody | null,
  right: UpdateProviderRuntimeSettingsBody | null
): boolean {
  return JSON.stringify(left ?? {}) === JSON.stringify(right ?? {});
}

function formFromDescriptor(
  settings: UpdateProviderRuntimeSettingsBody
): UpdateProviderRuntimeSettingsBody {
  return {
    thinkingEnabled: settings.thinkingEnabled,
    reasoningEffort: settings.reasoningEffort,
    maxOutputTokens: settings.maxOutputTokens,
    maxToolIterations: settings.maxToolIterations,
    providerCompactionEnabled: settings.providerCompactionEnabled,
    promptCachePreference: settings.promptCachePreference,
    parallelToolCallsEnabled: settings.parallelToolCallsEnabled,
  };
}

export function ProviderSettingsPage() {
  const { provider } = useParams({ from: '/_authenticated/settings/providers/$provider' });
  const { t } = useI18n();
  const { descriptor, isLoading, error, refetch } = useProviderSettings(provider);
  const s = t.settings.providers;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-sm text-on-surface-variant">{t.common.loading}</p>
      </div>
    );
  }

  if (error || !descriptor) {
    return (
      <div className="flex flex-col items-center gap-3 py-16">
        <p className="text-sm text-destructive">{s.loadError}</p>
        <Button variant="ghost" size="sm" onClick={() => void refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const providerName = t.providers[descriptor.provider] ?? descriptor.displayName;

  return (
    <ProviderSettingsEditor
      key={provider}
      provider={provider}
      descriptor={descriptor}
      providerName={providerName}
    />
  );
}

interface ProviderSettingsEditorProps {
  provider: string;
  descriptor: NonNullable<ReturnType<typeof useProviderSettings>['descriptor']>;
  providerName: string;
}

function ProviderSettingsEditor({
  provider,
  descriptor,
  providerName,
}: ProviderSettingsEditorProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const updateMutation = useUpdateProviderSettings(provider);
  const s = t.settings.providers;
  const initialForm = formFromDescriptor(descriptor.settings);
  const [form, setForm] = useState<UpdateProviderRuntimeSettingsBody>(initialForm);
  const [committedForm, setCommittedForm] =
    useState<UpdateProviderRuntimeSettingsBody>(initialForm);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = !areProviderSettingsEqual(form, committedForm);

  const persistForm = useCallback(async () => {
    if (!dirty) return;

    const requestedForm = form;
    try {
      const nextDescriptor = await updateMutation.mutateAsync(requestedForm);
      const nextCommittedForm = formFromDescriptor(nextDescriptor.settings);
      setCommittedForm(nextCommittedForm);
      setForm((currentForm) =>
        areProviderSettingsEqual(currentForm, requestedForm) ? nextCommittedForm : currentForm
      );
    } catch (err) {
      setForm((currentForm) =>
        areProviderSettingsEqual(currentForm, requestedForm) ? committedForm : currentForm
      );
      toast(err instanceof Error ? err.message : s.saveError, 'error');
    }
  }, [committedForm, dirty, form, s.saveError, toast, updateMutation]);

  useEffect(() => {
    if (!dirty || updateMutation.isPending) return;

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = setTimeout(() => {
      void persistForm();
    }, PROVIDER_SETTINGS_AUTOSAVE_MS);

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [dirty, persistForm, updateMutation.isPending]);

  useEffect(
    () => () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
      if (!dirty || updateMutation.isPending) return;
      void persistForm();
    },
    [dirty, persistForm, updateMutation.isPending]
  );

  return (
    <div className="space-y-6">
      <Link
        to="/settings/providers"
        className="inline-flex items-center gap-1.5 text-xs text-on-surface-variant hover:text-on-surface transition-colors"
      >
        <ArrowLeft size={14} />
        {s.backToMenu}
      </Link>

      <div>
        <h2 className="text-lg font-bold text-on-surface">{providerName}</h2>
        <p className="mt-0.5 text-xs text-on-surface-variant">{s.perProviderSettings}</p>
        {updateMutation.isPending && (
          <p className="mt-1 text-xs text-on-surface-variant" role="status" aria-live="polite">
            {s.saving}
          </p>
        )}
      </div>

      <div className="space-y-4">
        <ReasoningSettingsSection policy={descriptor.reasoning} form={form} onChange={setForm} />
        <ToolSettingsSection
          maxOutputTokensLimit={descriptor.maxOutputTokensLimit}
          toolUseSupported={descriptor.toolUseSupported}
          form={form}
          onChange={setForm}
        />
        <CacheSettingsSection
          cachingSupported={descriptor.promptCachingSupported}
          form={form}
          onChange={setForm}
        />
        <ProviderAdvancedSection />
      </div>
    </div>
  );
}
