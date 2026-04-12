/**
 * Hook: add-connector form state, validation, and submission.
 */

import { useState } from 'react';
import type { Connector, ProviderType } from '@mangostudio/shared';
import { addConnector } from '../api';

interface ConnectorFormState {
  name: string;
  apiKey: string;
  provider: ProviderType;
  baseUrl: string;
  organizationId: string;
  projectId: string;
  source: Connector['source'];
}

const INITIAL_FORM: ConnectorFormState = {
  name: '',
  apiKey: '',
  provider: 'gemini',
  baseUrl: '',
  organizationId: '',
  projectId: '',
  source: 'bun-secrets',
};

interface UseConnectorFormOptions {
  onSuccess: () => void | Promise<void>;
  errorRequired: string;
  baseUrlRequired: string;
}

export function useConnectorForm({
  onSuccess,
  errorRequired,
  baseUrlRequired,
}: UseConnectorFormOptions) {
  const [form, setForm] = useState<ConnectorFormState>(INITIAL_FORM);
  const [isSaving, setIsSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);

  const reset = () => {
    setForm(INITIAL_FORM);
    setFormError(null);
    setShowKey(false);
  };

  const submit = async () => {
    if (!form.name.trim() || !form.apiKey.trim()) {
      setFormError(errorRequired);
      return;
    }
    if (form.provider === 'openai-compatible' && !form.baseUrl.trim()) {
      setFormError(baseUrlRequired);
      return;
    }

    setIsSaving(true);
    setFormError(null);

    try {
      const body: Parameters<typeof addConnector>[0] = {
        name: form.name,
        apiKey: form.apiKey,
        source: form.source,
        provider: form.provider,
      };
      if (form.provider === 'openai-compatible' && form.baseUrl.trim()) {
        body.baseUrl = form.baseUrl.trim();
      }
      if (form.provider === 'openai') {
        if (form.organizationId.trim()) body.organizationId = form.organizationId.trim();
        if (form.projectId.trim()) body.projectId = form.projectId.trim();
      }

      await addConnector(body);
      await onSuccess();
      reset();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsSaving(false);
    }
  };

  return { form, setForm, isSaving, formError, showKey, setShowKey, submit, reset };
}
