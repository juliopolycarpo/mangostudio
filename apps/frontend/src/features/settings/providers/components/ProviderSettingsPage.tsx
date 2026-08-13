/**
 * Provider settings detail page.
 * Shows runtime controls for a single provider based on its descriptor.
 */

import type { UpdateProviderRuntimeSettingsBody } from '@mangostudio/shared/provider-settings';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { resolveApiErrorMessage } from '@/lib/utils';
import { useProviderSettings, useUpdateProviderSettings } from '../hooks/use-provider-settings';
import { CacheSettingsSection } from './CacheSettingsSection';
import { ProviderAdvancedSection } from './ProviderAdvancedSection';
import { ReasoningSettingsSection } from './ReasoningSettingsSection';
import { ToolSettingsSection } from './ToolSettingsSection';

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
          {t.common.retry}
        </Button>
      </div>
    );
  }

  const providerName = t.providers[descriptor.provider] ?? descriptor.displayName;

  if (descriptor.deprecated) {
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
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold text-on-surface">{providerName}</h2>
            <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-200 border border-amber-500/20">
              {s.deprecatedBadge}
            </span>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-on-surface-variant">{s.deprecatedNote}</p>
        </div>
      </div>
    );
  }

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

  // Both states are seeded once at mount, so a descriptor refreshed by another
  // tab's write would never reach these controls — the section would keep
  // showing the value it loaded with, and the next local edit would PUT that
  // whole stale form back over the remote change. Adopt the remote value only
  // into a form the user has not edited: one still matching the descriptor this
  // editor was last showing has no local edit to lose.
  const shownFormRef = useRef(initialForm);

  useEffect(() => {
    const nextForm = formFromDescriptor(descriptor.settings);
    const shownForm = shownFormRef.current;
    if (areProviderSettingsEqual(shownForm, nextForm)) return;
    shownFormRef.current = nextForm;

    setForm((currentForm) =>
      areProviderSettingsEqual(currentForm, shownForm) ? nextForm : currentForm
    );
    // Always the newest known server state, so a dirty form stays dirty against
    // it and a failed save rolls back to what the server actually holds.
    setCommittedForm(nextForm);
  }, [descriptor.settings]);

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
      toast(resolveApiErrorMessage(err, s.saveError), 'error');
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
