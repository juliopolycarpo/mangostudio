/**
 * Direct URL half of an environment card: the address the hub dials and the
 * write-only serve token stored in the OS secret store.
 */

import type { Environment, HttpEnvironmentConfig } from '@mangostudio/shared/environments';
import { shouldWarnPlaintextHttpRuntime } from '@mangostudio/shared/environments';
import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useI18n } from '@/hooks/use-i18n';
import { resolveApiErrorMessage } from '@/lib/utils';
import { useUpdateEnvironmentMutation } from '../queries';

interface DirectUrlPanelProps {
  readonly environment: Environment;
}

function httpConfig(environment: Environment): HttpEnvironmentConfig {
  const config = environment.config as Partial<HttpEnvironmentConfig>;
  return { baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl : '' };
}

export function DirectUrlPanel({ environment }: DirectUrlPanelProps) {
  const { t } = useI18n();
  const labels = t.environments.entities.directUrl;
  const update = useUpdateEnvironmentMutation();
  const initial = httpConfig(environment);
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  const trimmedBaseUrl = baseUrl.trim();
  const trimmedToken = token.trim();
  const baseChanged = trimmedBaseUrl !== initial.baseUrl;
  const canSave = (baseChanged && trimmedBaseUrl.length > 0) || trimmedToken.length > 0;
  const warnPlaintext = shouldWarnPlaintextHttpRuntime(trimmedBaseUrl);

  const save = async () => {
    if (!canSave) return;
    setError(null);
    try {
      await update.mutateAsync({
        id: environment.id,
        updates: {
          ...(baseChanged ? { config: { baseUrl: trimmedBaseUrl } } : {}),
          ...(trimmedToken ? { token: trimmedToken } : {}),
        },
      });
      setToken('');
    } catch (caught) {
      setError(resolveApiErrorMessage(caught, labels.saveFailed));
    }
  };

  return (
    <section
      className="space-y-3 rounded-xl border border-outline-variant/20 bg-surface-container-lowest/60 p-3"
      data-testid="direct-url-panel"
    >
      <div className="flex items-start gap-2">
        <KeyRound size={14} className="mt-0.5 shrink-0 text-primary" />
        <div className="min-w-0 space-y-0.5">
          <p className="font-semibold text-on-surface text-xs">{labels.title}</p>
          <p className="text-[11px] text-on-surface-variant/70">{labels.description}</p>
        </div>
      </div>

      <div className="space-y-1">
        <Input
          id={`direct-url-base-${environment.id}`}
          label={labels.baseUrlLabel}
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
        <p className="text-[11px] text-on-surface-variant/60">{labels.baseUrlHint}</p>
      </div>

      {warnPlaintext ? (
        <p className="rounded-lg border border-warning/35 bg-warning/5 px-2.5 py-2 text-[11px] text-on-surface-variant">
          {labels.plaintextWarning}
        </p>
      ) : null}

      <div className="space-y-1">
        <Input
          id={`direct-url-token-${environment.id}`}
          label={labels.tokenLabel}
          type="password"
          autoComplete="off"
          value={token}
          placeholder={environment.hasRuntimeToken ? '••••••••' : undefined}
          onChange={(event) => setToken(event.target.value)}
        />
        <p className="text-[11px] text-on-surface-variant/60">{labels.tokenHint}</p>
        <p className="text-[11px] text-on-surface-variant/70">
          {environment.hasRuntimeToken ? labels.tokenSet : labels.tokenMissing}
        </p>
      </div>

      {error ? (
        <p className="text-[11px] text-error" role="alert">
          {error}
        </p>
      ) : null}

      <Button
        variant="secondary"
        className="h-8 px-2.5 text-xs"
        disabled={!canSave}
        loading={update.isPending}
        onClick={() => void save()}
      >
        {environment.hasRuntimeToken && trimmedToken ? labels.tokenRotate : labels.tokenSave}
      </Button>
    </section>
  );
}
