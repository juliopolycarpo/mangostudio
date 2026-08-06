/**
 * Step 2 — the one real decision in the flow.
 *
 * Both answers reach the same machine over the same ssh credentials; what
 * differs is who dials whom afterwards. That is worth asking once, in these
 * words, rather than leaving somebody to infer it from a transport name.
 *
 * The environment row is created here, and it is the flow's only anchor:
 * everything after this point is resumable from it, and abandoning the flow
 * leaves a normal environment card rather than something stranded.
 */

import type { CreateEnvironmentBody, Environment } from '@mangostudio/shared/environments';
import { useId, useState } from 'react';
import { Input } from '@/components/ui/Input';
import { useI18n } from '@/hooks/use-i18n';
import { resolveApiErrorMessage } from '@/lib/utils';
import { useCreateEnvironmentMutation, useRuntimePairingQuery } from '../queries';
import type { SshFormFields } from '../ssh-form';
import { sshFormToConfig } from '../ssh-form';
import { StepActions } from './StepActions';
import type { OnboardingEndState } from './steps';

/** Mirrors `EnvironmentIdSchema`; the server is still the authority. */
const ENVIRONMENT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENVIRONMENT_ID_MAX_LENGTH = 63;
const ENVIRONMENT_NAME_MAX_LENGTH = 80;

function suggestId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, ENVIRONMENT_ID_MAX_LENGTH)
    .replace(/-+$/, '');
}

interface EndStateStepProps {
  readonly ssh: SshFormFields;
  readonly endState: OnboardingEndState;
  /** Set when the row already exists, either from a retry or from a resume. */
  readonly existing: Environment | undefined;
  readonly onEndState: (endState: OnboardingEndState) => void;
  readonly onCreated: (environmentId: string) => void;
  readonly onContinue: () => void;
  readonly onBack: () => void;
}

export function EndStateStep({
  ssh,
  endState,
  existing,
  onEndState,
  onCreated,
  onContinue,
  onBack,
}: EndStateStepProps) {
  const { t } = useI18n();
  const labels = t.environments.onboarding;
  const add = t.environments.entities.add;
  const create = useCreateEnvironmentMutation();
  const groupId = useId();

  const [name, setName] = useState(existing?.name ?? ssh.host);
  const [id, setId] = useState('');
  const [idEdited, setIdEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedName = name.trim();
  const effectiveId = existing?.id ?? (idEdited ? id.trim() : suggestId(trimmedName));
  const idInvalid = effectiveId.length > 0 && !ENVIRONMENT_ID_PATTERN.test(effectiveId);

  // Asking the hub for its own dial address needs a pairable row, so the gate
  // can only answer once one exists. That is why this reads the pairing status
  // of the row just created rather than a config endpoint: no new surface, and
  // the answer still arrives at step 2 instead of three steps later with a
  // provisioned machine that has nowhere to dial.
  const pairing = useRuntimePairingQuery(
    existing?.id ?? '',
    Boolean(existing) && existing?.transportKind === 'websocket'
  );
  const dialEndpointMissing =
    endState === 'paired' && pairing.isSuccess && pairing.data?.endpoint === null;

  const submit = async () => {
    if (existing) {
      if (dialEndpointMissing) return;
      onContinue();
      return;
    }
    setError(null);
    const body: CreateEnvironmentBody =
      endState === 'paired'
        ? {
            id: effectiveId,
            name: trimmedName,
            transportKind: 'websocket',
            // Nothing to configure hub-side: the machine identifies itself with
            // the credential the bootstrap hands it over ssh.
            config: {},
          }
        : {
            id: effectiveId,
            name: trimmedName,
            transportKind: 'ssh',
            config: sshFormToConfig(ssh),
          };
    try {
      const created = await create.mutateAsync(body);
      onCreated(created.id);
      // The paired branch stays on this step until the dial address is known:
      // advancing would provision a machine that has nowhere to call back to.
      if (endState !== 'paired') onContinue();
    } catch (caught) {
      setError(resolveApiErrorMessage(caught, add.createFailed));
    }
  };

  const choices: readonly { readonly value: OnboardingEndState; readonly label: string }[] = [
    { value: 'ssh', label: labels.endStateSsh },
    { value: 'paired', label: labels.endStatePaired },
  ];

  return (
    <div className="space-y-4" data-testid="onboarding-end-state-step">
      <fieldset className="space-y-2">
        <legend className="font-medium text-on-surface-variant text-sm">
          {labels.endStateLabel}
        </legend>
        {/* Real radios rather than styled buttons: this is one choice out of
            two, and arrow-key navigation and the announced group come free. */}
        <div className="grid gap-2">
          {choices.map((choice) => (
            <label
              key={choice.value}
              className={`cursor-pointer rounded-xl border px-3 py-2 text-left font-semibold text-sm transition-colors has-disabled:cursor-default has-disabled:opacity-60 ${
                endState === choice.value
                  ? 'border-primary/45 bg-primary/10 text-on-surface'
                  : 'border-outline-variant/20 text-on-surface-variant/70 hover:bg-surface-container-highest'
              }`}
            >
              <input
                type="radio"
                name={groupId}
                value={choice.value}
                checked={endState === choice.value}
                disabled={Boolean(existing)}
                onChange={() => onEndState(choice.value)}
                className="sr-only"
              />
              {choice.label}
            </label>
          ))}
        </div>
        <div className="rounded-xl border border-primary/35 bg-primary/5 px-3 py-2.5">
          <p className="text-on-surface-variant/70 text-xs">
            {endState === 'paired' ? labels.endStatePairedHint : labels.endStateSshHint}
          </p>
        </div>
      </fieldset>

      {dialEndpointMissing ? (
        <p
          className="rounded-xl border border-warning/35 bg-warning/5 px-3 py-2.5 text-on-surface-variant text-xs"
          role="alert"
          data-testid="onboarding-public-url-gate"
        >
          {t.environments.entities.pairing.endpointUnset}
        </p>
      ) : null}

      {existing ? null : (
        <>
          <Input
            id="onboarding-name"
            label={add.nameLabel}
            value={name}
            maxLength={ENVIRONMENT_NAME_MAX_LENGTH}
            error={name.length > 0 && trimmedName.length === 0 ? add.nameRequired : undefined}
            onChange={(event) => setName(event.target.value)}
          />
          <div className="space-y-1">
            <Input
              id="onboarding-id"
              label={add.idLabel}
              value={effectiveId}
              maxLength={ENVIRONMENT_ID_MAX_LENGTH}
              error={idInvalid ? add.idInvalid : undefined}
              onChange={(event) => {
                setIdEdited(true);
                setId(event.target.value);
              }}
            />
            {!idInvalid && <p className="text-on-surface-variant/60 text-xs">{add.idHint}</p>}
          </div>
        </>
      )}

      {error ? (
        <p className="text-error text-xs" role="alert">
          {error}
        </p>
      ) : null}

      <StepActions
        backLabel={labels.back}
        onBack={onBack}
        continueLabel={labels.continue}
        continuePending={create.isPending}
        continueDisabled={
          dialEndpointMissing ||
          (!existing && (trimmedName.length === 0 || effectiveId.length === 0 || idInvalid))
        }
        onContinue={() => void submit()}
      />
    </div>
  );
}
