/**
 * Provider settings detail page.
 * Shows runtime controls for a single provider based on its descriptor.
 */

import { useState, useCallback } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import type { UpdateProviderRuntimeSettingsBody } from '@mangostudio/shared/provider-settings';
import { useI18n } from '@/hooks/use-i18n';
import { useProviderSettings } from '../hooks/use-provider-settings';
import { updateProviderSettings } from '../api';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { ReasoningSettingsSection } from './ReasoningSettingsSection';
import { ToolSettingsSection } from './ToolSettingsSection';
import { CacheSettingsSection } from './CacheSettingsSection';
import { ProviderAdvancedSection } from './ProviderAdvancedSection';

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
  const { descriptor, isLoading, error, refetch, invalidate } = useProviderSettings(provider);
  const { toast } = useToast();
  const s = t.settings.providers;

  const [isSaving, setIsSaving] = useState(false);

  // Derive form from descriptor — reinitializes when provider changes
  const [form, setForm] = useState<UpdateProviderRuntimeSettingsBody>({});
  const [initialForm, setInitialForm] = useState<UpdateProviderRuntimeSettingsBody>({});
  const [prevProvider, setPrevProvider] = useState(provider);

  // When provider changes, reset form state
  if (provider !== prevProvider) {
    setPrevProvider(provider);
    setForm({});
    setInitialForm({});
  }

  // When descriptor loads, initialize form if not yet initialized
  if (descriptor && initialForm && Object.keys(initialForm).length === 0) {
    const init = formFromDescriptor(descriptor.settings);
    setForm(init);
    setInitialForm(init);
  }

  const dirty =
    Object.keys(initialForm).length > 0 &&
    Object.keys(form).length > 0 &&
    (initialForm.thinkingEnabled !== form.thinkingEnabled ||
      initialForm.reasoningEffort !== form.reasoningEffort ||
      initialForm.maxOutputTokens !== form.maxOutputTokens ||
      initialForm.maxToolIterations !== form.maxToolIterations ||
      initialForm.providerCompactionEnabled !== form.providerCompactionEnabled ||
      initialForm.promptCachePreference !== form.promptCachePreference ||
      initialForm.parallelToolCallsEnabled !== form.parallelToolCallsEnabled);

  const handleSave = useCallback(async () => {
    if (!descriptor || !dirty) return;
    setIsSaving(true);
    try {
      await updateProviderSettings(provider, form);
      toast(s.saved, 'success');
      await invalidate();
      setInitialForm({ ...form });
    } catch (err) {
      toast(err instanceof Error ? err.message : s.saveError, 'error');
    } finally {
      setIsSaving(false);
    }
  }, [descriptor, dirty, provider, form, toast, s, invalidate]);

  const handleCancel = useCallback(() => {
    setForm({ ...initialForm });
  }, [initialForm]);

  const handleReset = useCallback(() => {
    setForm({});
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-sm text-muted-foreground">{t.common.loading}</p>
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
    <div className="space-y-6">
      <Link
        to="/settings/providers"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft size={14} />
        {s.backToMenu}
      </Link>

      <div>
        <h2 className="text-lg font-bold text-foreground">{providerName}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{s.perProviderSettings}</p>
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

      <div className="flex items-center gap-3 pt-2">
        <Button
          variant="primary"
          size="sm"
          loading={isSaving}
          disabled={!dirty}
          onClick={() => void handleSave()}
        >
          {isSaving ? s.saving : s.save}
        </Button>
        <Button variant="secondary" size="sm" disabled={!dirty} onClick={handleCancel}>
          {s.cancel}
        </Button>
        <Button variant="ghost" size="sm" onClick={handleReset}>
          {s.reset}
        </Button>
      </div>
    </div>
  );
}
