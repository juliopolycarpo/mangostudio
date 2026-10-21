/**
 * Provider settings detail page.
 * Shows runtime controls for a single provider based on its descriptor.
 */

import type { UpdateProviderRuntimeSettingsBody } from '@mangostudio/shared/provider-settings';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SettingsPage } from '@/components/settings/SettingsPage';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Skeleton } from '@/components/ui/Skeleton';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD } from '@/lib/icon-sizes';
import { resolveApiErrorMessage } from '@/lib/utils';
import { useProviderSettings, useUpdateProviderSettings } from '../hooks/use-provider-settings';
import { CacheSettingsSection } from './CacheSettingsSection';
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

/** The way back to the provider list, above the page title it belongs to. */
function BackToProviders({ label }: { label: string }) {
  return (
    <Link
      to="/settings/providers"
      className="-ml-2 inline-flex h-7 items-center gap-1.5 rounded-sm px-2 text-xs font-medium text-fg-muted transition-colors hover:bg-fill-hover hover:text-fg"
    >
      <ArrowLeft size={ICON_MD} />
      {label}
    </Link>
  );
}

export function ProviderSettingsPage() {
  const { provider } = useParams({ from: '/_authenticated/settings/providers/$provider' });
  const { t } = useI18n();
  const { descriptor, isLoading, error, refetch } = useProviderSettings(provider);
  const s = t.settings.providers;

  if (isLoading) {
    return (
      <div role="status" className="space-y-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full rounded-md" />
        <span className="sr-only">{t.common.loading}</span>
      </div>
    );
  }

  if (error || !descriptor) {
    return (
      <Callout
        tone="danger"
        action={
          <Button variant="secondary" size="sm" onClick={() => void refetch()}>
            {t.common.retry}
          </Button>
        }
      >
        {s.loadError}
      </Callout>
    );
  }

  const providerName = t.providers[descriptor.provider] ?? descriptor.displayName;

  if (descriptor.deprecated) {
    return (
      <div className="space-y-6">
        <BackToProviders label={s.backToMenu} />
        <SettingsPage title={providerName}>
          <Callout tone="warning" title={s.deprecatedBadge}>
            {s.deprecatedNote}
          </Callout>
        </SettingsPage>
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
      <BackToProviders label={s.backToMenu} />
      <SettingsPage
        title={providerName}
        description={s.perProviderSettings}
        actions={
          updateMutation.isPending ? (
            <div
              className="inline-flex items-center gap-1.5 text-xs text-fg-muted"
              role="status"
              aria-live="polite"
            >
              <Spinner size="sm" />
              {s.saving}
            </div>
          ) : null
        }
      >
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
      </SettingsPage>
    </div>
  );
}
