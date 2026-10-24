/**
 * Creates an execution environment.
 *
 * The first question is "how do you reach that machine", not "which protocol":
 * a user knows whether the target is this box, a distribution on it, or a
 * machine somewhere else, and knows nothing useful about the difference between
 * a spawned child and a dialed-in socket. Each answer picks the transport that
 * fits it. Answers whose transport does not exist yet are not offered — a row
 * that can never do anything is worse than a missing one.
 */

import type { CreateEnvironmentBody, WslDistribution } from '@mangostudio/shared/environments';
import {
  DEFAULT_SSH_RUNTIME_PATH,
  shouldWarnPlaintextHttpRuntime,
  sshPreflightCommands,
} from '@mangostudio/shared/environments/values';
import { Cable, Container, Globe, KeyRound, Laptop, SquareTerminal } from 'lucide-react';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { PickOneRow } from '@/components/settings/PickOneRow';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD } from '@/lib/icon-sizes';
import { resolveApiErrorMessage } from '@/lib/utils';
import {
  type ContainerFormFields,
  containerFormToConfig,
  defaultContainerForm,
  isContainerFormUsable,
  validateContainerForm,
} from '../container-form';
import {
  useContainerDetectionQuery,
  useCreateEnvironmentMutation,
  useWslDetectionQuery,
} from '../queries';
import { isSshFormUsable, SSH_LEADING_DASH, sshFormToConfig, validateSshForm } from '../ssh-form';
import { ContainerConfigFields } from './ContainerConfigFields';
import { CopyLine } from './CopyLine';
import { WslDistributionPicker } from './WslDistributionPicker';

/** Mirrors `EnvironmentIdSchema`; the server is still the authority. */
const ENVIRONMENT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENVIRONMENT_ID_MAX_LENGTH = 63;
const ENVIRONMENT_NAME_MAX_LENGTH = 80;

/** One answer to "how do you reach it", and the transport that answer implies. */
type ReachabilityChoice = 'stdio' | 'wsl' | 'container' | 'websocket' | 'http' | 'ssh';

interface AddEnvironmentDialogProps {
  readonly onClose: () => void;
  /**
   * Opens the guided flow instead of this form. Offered as a picker answer
   * because "set up a new machine" is the same question this dialog asks —
   * a user who has one does not know yet that it is an ssh answer.
   */
  readonly onStartOnboarding?: () => void;
}

/** Derives an id from a name so the common case needs one field, not two. */
function suggestId(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, ENVIRONMENT_ID_MAX_LENGTH)
      // The cut can land just after an internal dash, and a trailing one fails
      // the pattern — leaving submit disabled over an id the user never typed.
      .replace(/-+$/, '')
  );
}

/** The one to offer first: the host's default, else whatever is configurable. */
function preferredDistro(offered: readonly WslDistribution[]): string {
  return (offered.find((distribution) => distribution.default) ?? offered[0])?.name ?? '';
}

export function AddEnvironmentDialog({ onClose, onStartOnboarding }: AddEnvironmentDialogProps) {
  const { t } = useI18n();
  const labels = t.environments.entities.add;
  const create = useCreateEnvironmentMutation();
  const reachGroupName = useId();

  const [kind, setKind] = useState<ReachabilityChoice>('stdio');
  const [name, setName] = useState('');
  // Tracked separately so typing an id once stops the name from overwriting it.
  const [id, setId] = useState('');
  const [idEdited, setIdEdited] = useState(false);
  const [nameEdited, setNameEdited] = useState(false);
  const [binaryPath, setBinaryPath] = useState('');
  const [cwd, setCwd] = useState('');
  const [distro, setDistro] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [sshHost, setSshHost] = useState('');
  const [sshUser, setSshUser] = useState('');
  const [sshPort, setSshPort] = useState('');
  const [sshIdentityFile, setSshIdentityFile] = useState('');
  const [sshRuntimePath, setSshRuntimePath] = useState('');
  const [container, setContainer] = useState<ContainerFormFields>(defaultContainerForm());
  const [error, setError] = useState<string | null>(null);

  const wsl = useWslDetectionQuery(true);
  const containers = useContainerDetectionQuery(true);
  const containerOffered = containers.data?.available === true;
  const distributions = wsl.data?.distributions ?? [];
  const wslOffered = wsl.data?.available === true;
  const offered = distributions.filter((distribution) => !distribution.environmentId);

  // The host picks the distribution, not the user typing its name. Until one is
  // touched, the tab tracks whatever the host calls default.
  const selectedDistro = distro || preferredDistro(offered);
  // A name chosen from one listing is not a choice against the next one: the
  // detection refetches while the dialog is open, and a distribution can be
  // claimed by another environment or removed from the host between them.
  const selectionOffered = offered.some((distribution) => distribution.name === selectedDistro);

  useEffect(() => {
    if (kind !== 'wsl' || nameEdited || !selectedDistro) return;
    setName(selectedDistro);
  }, [kind, nameEdited, selectedDistro]);

  // The engine field defaults to docker, which is wrong on a machine that only
  // has podman. Detection moves it once, before anything is typed; after that
  // the field is the user's.
  const detectedEngine = containers.data?.engines.find((entry) => entry.available)?.engine;
  useEffect(() => {
    if (!detectedEngine) return;
    setContainer((current) =>
      current.image === '' && current.engine === 'docker'
        ? { ...current, engine: detectedEngine }
        : current
    );
  }, [detectedEngine]);

  const trimmedName = name.trim();
  const trimmedBaseUrl = baseUrl.trim();
  const trimmedToken = token.trim();
  const effectiveId = idEdited ? id.trim() : suggestId(trimmedName);
  const idInvalid = effectiveId.length > 0 && !ENVIRONMENT_ID_PATTERN.test(effectiveId);
  const httpIncomplete =
    kind === 'http' && (trimmedBaseUrl.length === 0 || trimmedToken.length === 0);
  const sshForm = {
    host: sshHost,
    user: sshUser,
    port: sshPort,
    identityFile: sshIdentityFile,
    remoteRuntimePath: sshRuntimePath,
  };
  const sshConfig = sshFormToConfig(sshForm);
  const sshFieldInvalid = validateSshForm(sshForm);
  const sshInvalid = kind === 'ssh' && !isSshFormUsable(sshForm);
  const containerErrors = validateContainerForm(container);
  const containerInvalid = kind === 'container' && !isContainerFormUsable(container);
  const blocked =
    trimmedName.length === 0 ||
    effectiveId.length === 0 ||
    idInvalid ||
    httpIncomplete ||
    sshInvalid ||
    containerInvalid ||
    (kind === 'wsl' && !selectionOffered);

  const choices: {
    readonly value: ReachabilityChoice;
    readonly label: string;
    readonly icon: ReactNode;
  }[] = [
    { value: 'stdio', label: labels.reachLocal, icon: <Laptop size={ICON_MD} /> },
    ...(wslOffered
      ? [{ value: 'wsl' as const, label: labels.reachWsl, icon: <SquareTerminal size={ICON_MD} /> }]
      : []),
    ...(containerOffered
      ? [
          {
            value: 'container' as const,
            label: labels.reachContainer,
            icon: <Container size={ICON_MD} />,
          },
        ]
      : []),
    { value: 'websocket', label: labels.reachPaired, icon: <Cable size={ICON_MD} /> },
    { value: 'http', label: labels.reachDirect, icon: <Globe size={ICON_MD} /> },
    { value: 'ssh', label: labels.reachSsh, icon: <KeyRound size={ICON_MD} /> },
  ];
  const hints: Record<ReachabilityChoice, string> = {
    stdio: labels.stdioHint,
    wsl: labels.wslHint,
    container: labels.containerHint,
    websocket: labels.pairedHint,
    http: labels.directHint,
    ssh: labels.sshHint,
  };

  const handleSubmit = async () => {
    if (blocked) return;
    setError(null);

    const trimmedBinaryPath = binaryPath.trim();
    const trimmedCwd = cwd.trim();
    const body: CreateEnvironmentBody =
      kind === 'wsl'
        ? {
            id: effectiveId,
            name: trimmedName,
            transportKind: 'wsl',
            config: { distro: selectedDistro },
          }
        : kind === 'websocket'
          ? {
              id: effectiveId,
              name: trimmedName,
              transportKind: 'websocket',
              // Nothing to configure hub-side: the machine identifies itself
              // with the pairing token the card issues after this.
              config: {},
            }
          : kind === 'http'
            ? {
                id: effectiveId,
                name: trimmedName,
                transportKind: 'http',
                config: { baseUrl: trimmedBaseUrl },
                token: trimmedToken,
              }
            : kind === 'ssh'
              ? {
                  id: effectiveId,
                  name: trimmedName,
                  transportKind: 'ssh',
                  config: sshConfig,
                }
              : kind === 'container'
                ? {
                    id: effectiveId,
                    name: trimmedName,
                    transportKind: 'container',
                    config: containerFormToConfig(container),
                  }
                : {
                    id: effectiveId,
                    name: trimmedName,
                    transportKind: 'stdio',
                    // An omitted field means "use the default"; an empty string would
                    // be a path the launcher then tries to spawn.
                    config: {
                      ...(trimmedBinaryPath ? { binaryPath: trimmedBinaryPath } : {}),
                      ...(trimmedCwd ? { cwd: trimmedCwd } : {}),
                    },
                  };

    try {
      await create.mutateAsync(body);
      onClose();
    } catch (caught) {
      setError(resolveApiErrorMessage(caught, labels.createFailed));
    }
  };

  return (
    <Dialog
      testId="add-environment-dialog"
      title={labels.title}
      description={labels.description}
      onClose={onClose}
      footer={
        <>
          {/* On the left, away from the actions: it leaves rather than selects.
              The guided flow asks these same questions in an order that suits
              somebody who has a bare machine and no environment yet, so it is
              not one of the answers above and not a button of this form. The
              ellipsis says a flow opens; what it walks through is the hover. */}
          {onStartOnboarding ? (
            <Button
              variant="subtle"
              onClick={onStartOnboarding}
              title={labels.newMachineHint}
              className="mr-auto"
              data-testid="add-environment-onboarding"
            >
              {labels.reachNewMachine}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose}>
            {labels.cancel}
          </Button>
          <Button
            variant="primary"
            disabled={blocked}
            loading={create.isPending}
            onClick={() => void handleSubmit()}
          >
            {labels.submit}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-2">
          {/* Real radios: one choice out of several, arrow keys between them,
              announced as a group under its question. The current row wears the
              navigation's mark (fill and 3px accent bar), as in every pick-one list. */}
          <fieldset className="min-w-0 space-y-2">
            <legend className="text-sm font-medium text-fg">{labels.reachLabel}</legend>
            <div className="grid gap-2">
              {choices.map((choice) => (
                <PickOneRow
                  key={choice.value}
                  name={reachGroupName}
                  checked={kind === choice.value}
                  onSelect={() => setKind(choice.value)}
                  icon={choice.icon}
                  title={choice.label}
                />
              ))}
            </div>
          </fieldset>
          {/* Straight under the tiles: it explains the answer just picked. */}
          <Callout tone="neutral">{hints[kind]}</Callout>
        </div>

        {kind === 'wsl' ? (
          <div className="space-y-1">
            <p className="text-sm font-medium text-fg">{labels.wslDistroLabel}</p>
            <WslDistributionPicker
              distributions={distributions}
              selected={selectedDistro}
              onSelect={setDistro}
            />
          </div>
        ) : null}

        <Input
          id="add-environment-name"
          label={labels.nameLabel}
          value={name}
          autoFocus
          maxLength={ENVIRONMENT_NAME_MAX_LENGTH}
          // Only once something was typed: a blank untouched field is the
          // starting state, not a mistake worth flagging.
          error={name.length > 0 && trimmedName.length === 0 ? labels.nameRequired : undefined}
          onChange={(event) => {
            setNameEdited(true);
            setName(event.target.value);
          }}
        />

        <Input
          id="add-environment-id"
          label={labels.idLabel}
          value={effectiveId}
          maxLength={ENVIRONMENT_ID_MAX_LENGTH}
          error={idInvalid ? labels.idInvalid : undefined}
          onChange={(event) => {
            setIdEdited(true);
            setId(event.target.value);
          }}
          hint={labels.idHint}
        />

        {kind === 'stdio' ? (
          <OptionalFields label={labels.optional}>
            <Input
              id="add-environment-binary-path"
              label={labels.binaryPathLabel}
              value={binaryPath}
              onChange={(event) => setBinaryPath(event.target.value)}
              hint={labels.binaryPathHint}
            />

            <Input
              id="add-environment-cwd"
              label={labels.cwdLabel}
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
              hint={labels.cwdHint}
            />
          </OptionalFields>
        ) : null}

        {kind === 'container' ? (
          <ContainerConfigFields
            idPrefix="add-environment-container"
            form={container}
            errors={containerErrors}
            detection={containers.data}
            onChange={(patch) => setContainer((current) => ({ ...current, ...patch }))}
          />
        ) : null}

        {kind === 'websocket' ? <Callout tone="info">{labels.pairedNext}</Callout> : null}

        {kind === 'http' ? (
          <>
            <Input
              id="add-environment-base-url"
              label={labels.directBaseUrlLabel}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
            {shouldWarnPlaintextHttpRuntime(trimmedBaseUrl) ? (
              <Callout tone="warning">{labels.directPlaintextWarning}</Callout>
            ) : null}
            <Input
              id="add-environment-token"
              label={labels.directTokenLabel}
              type="password"
              autoComplete="off"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </>
        ) : null}

        {kind === 'ssh' ? (
          <>
            <Input
              id="add-environment-ssh-host"
              label={labels.sshHostLabel}
              value={sshHost}
              error={
                sshHost.trim().length > 0 && SSH_LEADING_DASH.test(sshHost.trim())
                  ? labels.sshDashInvalid
                  : undefined
              }
              onChange={(event) => setSshHost(event.target.value)}
            />

            <OptionalFields label={labels.optional}>
              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  id="add-environment-ssh-user"
                  label={labels.sshUserLabel}
                  value={sshUser}
                  error={
                    sshUser.trim().length > 0 && SSH_LEADING_DASH.test(sshUser.trim())
                      ? labels.sshDashInvalid
                      : undefined
                  }
                  onChange={(event) => setSshUser(event.target.value)}
                />
                <Input
                  id="add-environment-ssh-port"
                  label={labels.sshPortLabel}
                  inputMode="numeric"
                  placeholder="22"
                  value={sshPort}
                  error={
                    sshPort.trim().length > 0 && sshFieldInvalid === 'port'
                      ? labels.sshPortInvalid
                      : undefined
                  }
                  onChange={(event) => setSshPort(event.target.value)}
                />
                <Input
                  id="add-environment-ssh-identity"
                  label={labels.sshIdentityFileLabel}
                  value={sshIdentityFile}
                  error={
                    sshIdentityFile.trim().length > 0 &&
                    SSH_LEADING_DASH.test(sshIdentityFile.trim())
                      ? labels.sshDashInvalid
                      : undefined
                  }
                  onChange={(event) => setSshIdentityFile(event.target.value)}
                />
              </div>

              <Input
                id="add-environment-ssh-runtime-path"
                label={labels.sshRuntimePathLabel}
                placeholder={DEFAULT_SSH_RUNTIME_PATH}
                value={sshRuntimePath}
                error={
                  sshRuntimePath.trim().length > 0 && SSH_LEADING_DASH.test(sshRuntimePath.trim())
                    ? labels.sshDashInvalid
                    : undefined
                }
                onChange={(event) => setSshRuntimePath(event.target.value)}
                hint={labels.sshRuntimePathHint}
              />
            </OptionalFields>

            {sshConfig.host ? (
              <div className="space-y-2">
                <Callout tone="info">{labels.sshPreflight}</Callout>
                <CopyLine
                  label={labels.sshPreflightReach}
                  value={sshPreflightCommands(sshConfig).reach}
                />
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      {error ? (
        <Callout tone="danger" role="alert">
          {error}
        </Callout>
      ) : null}
    </Dialog>
  );
}

/**
 * Fields the request does without. The heading says so once; a suffix on every
 * label said it again four times over, in the label's own weight and colour.
 */
function OptionalFields({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <fieldset className="min-w-0 space-y-3">
      <legend className="mb-2">
        <MicroLabel>{label}</MicroLabel>
      </legend>
      {children}
    </fieldset>
  );
}
