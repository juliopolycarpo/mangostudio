import type { FeatureMessages } from './types';

/**
 * The English `environments` keys the first paint does not read (the rest stay in `en.ts`).
 * The feature's lazy chunk imports this file, so the strings arrive with the code
 * that renders them (see `FeatureNamespace` in `types.ts`).
 */
export const messages: FeatureMessages<'environments'> = {
  environments: {
    title: 'Environments',
    subtitle: 'What is installed, what is wrong, and what actually runs when you type.',
    /** Which machine a diagnostic tab is describing. */
    /** Per-environment permission to run install recipes on that machine. */
    trust: {
      label: 'Allow installs on this machine',
      hint: 'Runs allowlisted install recipes there, writing to that machine\u2019s disk. Remote installs need both the global install switch and this per-environment permission \u2014 the local-surface check that protects this machine says nothing about that one.',
      updateFailed: 'The install permission could not be changed.',
    },
    scope: {
      label: 'Environment',
      disconnected: '{environment} is not connected',
      disconnectedHint:
        'Nothing is shown rather than the last answer this machine gave, because a stale toolchain list is exactly what someone would act on.',
      connect: 'Connect',
      notPermitted: '{environment} does not report what is installed on it',
      notPermittedHint:
        'Its runtime does not offer toolchain detection. That is a setting on that machine, not a fault here.',
      libraryNotPermitted: '{environment} does not report library resources',
      libraryNotPermittedHint:
        'Its runtime does not offer library discovery. That is a setting on that machine, not a fault here.',
      libraryDisconnectedHint:
        'Nothing is shown rather than the last library matrix this machine gave, because a stale coverage answer is exactly what someone would act on.',
      compare: 'Compare',
      compareTitle: 'Compare environments',
      compareHint: 'Two machines, one table. Rows are what MangoStudio knows how to look for.',
      compareLeft: 'Left environment',
      compareRight: 'Right environment',
      compareClose: 'Close comparison',
      cellPresent: 'Present',
      cellAbsent: 'Not installed',
      cellNotPermitted: 'Not reported',
      cellUnknown: 'Not checked yet',
      rowGroupRuntime: 'Toolchains',
      rowGroupAgent: 'Agents',
      rowGroupShell: 'Shells',
      presenceOn: 'on {environment}',
      presencePresent: '{environment}: installed',
      presenceAbsent: '{environment}: not installed',
    },
    origins: {
      path: 'on PATH',
      'well-known': 'well-known location',
      'version-manager': 'version manager',
      configured: 'configured',
    },
    // Renaming is display-only: the id on the wire, the tool names providers
    // see, and every API path stay exactly as they were.
    identity: {
      menu: 'Identity options for {name}',
      rename: 'Rename…',
      // For a subject whose name is not the registry's to change (an MCP server's
      // is its configured name): the same dialog without the name field.
      customize: 'Set avatar…',
      reset: 'Reset to default',
      dialogTitle: 'Rename {name}',
      customizeDialogTitle: 'Set avatar for {name}',
      nameLabel: 'Display name',
      namePlaceholder: '{name}',
      nameHint: 'Leave empty to keep the default name. Only what you read changes.',
      monogramLabel: 'Monogram',
      monogramHint: 'One or two characters for the avatar. Leave empty to derive it from the name.',
      monogramInvalid: 'Use one or two characters, without spaces.',
      preview: 'Preview',
      imageLabel: 'Image',
      imageModeNone: 'No image',
      imageModeUpload: 'Upload',
      imageModeUrl: 'Address',
      imageChoose: 'Choose a file…',
      imageReplaceFile: 'Choose another…',
      imageNoFile: 'No file chosen',
      imageStoredFile: 'Using the image you uploaded',
      imageFileHint: 'PNG, JPEG, or WebP, up to 512 KB. SVG files are not accepted.',
      imageFileTooLarge: 'That file is larger than 512 KB. Choose a smaller one.',
      imageRightsNotice: 'Only upload an image you hold the rights to use.',
      imageUrlLabel: 'Image address',
      imageUrlPlaceholder: 'https://example.com/logo.png',
      imageUrlInvalid: 'Enter an address starting with https://.',
      imageCacheLabel: 'Cache this image here',
      imageCacheOnNotice:
        'The image is downloaded once and served from this machine. The remote site is never contacted again.',
      imageCacheOffNotice:
        'Your browser loads the image from the remote site every time it is shown. That site can count those requests, learn your approximate location from your IP address, and change the image after you save it — including to something you would not want shown.',
      save: 'Save',
      cancel: 'Cancel',
      saveFailed: 'The changes could not be saved.',
      resetFailed: 'The identity could not be reset.',
    },
    loadError: 'The environment state could not be loaded.',
    checkedAt: 'Checked at {time}',
    overview: {
      description: 'What this machine can run agents with, and what needs attention.',
      // Each section is a summary of a tab, so its link says which one it opens.
      // A sentence per tab rather than a template around the tab's label: the
      // label is capitalised for a tab strip, and a sentence is not.
      open: {
        runtimes: 'Open toolchains',
        agents: 'Open agents',
        health: 'Open health',
        library: 'Open library',
        machine: 'Open this machine',
      },
      agentDetails: 'Details',
      agentsEmpty: 'No agent CLI was found on this machine.',
      agentsEmptyHint: 'MangoStudio can install one for you from the Agents tab.',
      toolchainsEmpty: 'No toolchain was found on this machine.',
      healthClear: 'Nothing needs attention.',
      libraryEmpty: 'No library resources were found yet.',
      libraryPresent: '{count} present',
      libraryDivergent: '{count} divergent',
      libraryNone: 'Reads nothing yet',
      // The overview's "before you start" checklist. Every row reads state the
      // Toolchains, Agents, and This machine tabs already fetch — there is no
      // dedicated endpoint behind this section.
      setup: {
        title: 'Setup',
        description: 'What a new machine needs before agents can run on it.',
        status: {
          done: 'Done',
          todo: 'To do',
          optional: 'Optional',
        },
        git: {
          label: 'Git',
          explanation: 'Agents use Git to inspect history and commit their own changes.',
        },
        node: {
          label: 'A current Node.js',
          explanation: 'Some agent CLIs and MCP servers need a supported Node.js LTS to run.',
        },
        bun: {
          label: 'Bun',
          explanation:
            'MangoStudio itself runs on Bun. Optional here unless one of your agents needs it too.',
        },
        agent: {
          label: 'An agent CLI, signed in',
          explanation:
            'At least one agent CLI must be installed and signed in before you can chat.',
        },
        hubService: {
          label: 'MangoStudio running as a service',
          explanation: 'A per-user service keeps MangoStudio running after you close its window.',
        },
        gitDarwinRemedy: 'Run this in a terminal:',
        gitLinuxRemedy: "Install it with your Linux distribution's package manager.",
      },
    },
    onboarding: {
      title: 'Set up a new machine',
      progress: 'Step {step} of {total} · {name}',
      steps: {
        reach: 'Reach it',
        'end-state': 'End state',
        install: 'Runtime',
        permissions: 'Permissions',
        provision: 'Provision',
        tools: 'Tools',
        library: 'Library',
        done: 'Done',
      },
      continue: 'Continue',
      back: 'Back',
      finish: 'Finish',
      close: 'Close',
      missingEnvironment: 'This step needs the environment that the previous one creates.',
      reachIntro:
        'MangoStudio uses your own ssh client, so keys, your agent, ~/.ssh/config and known_hosts all apply. Nothing has to be installed on the machine first.',
      reachWindows:
        'Linux and macOS targets only. Windows is not supported over SSH — pair it from its own card instead.',
      endStateLabel: 'How should MangoStudio reach it afterwards?',
      endStateSsh: 'Over SSH, every time',
      endStateSshHint:
        'MangoStudio starts the runtime there with your ssh client whenever it needs it. Nothing runs on that machine in between, and there is no service to keep alive.',
      endStatePaired: 'The machine dials MangoStudio',
      endStatePairedHint:
        'Set up once over SSH, then the runtime connects on its own and stays connected — through a router, a firewall, or MangoStudio moving to another network. It needs a service on that machine to survive reboots.',
      endStatePairingUnavailable:
        'MangoStudio could not check whether it has a public address to hand the machine. Nothing has been done on that machine yet — try again.',
      endStatePairingRetry: 'Check again',
      permissionsSshIntro:
        'The runtime is on the machine. Say what MangoStudio may do with it — this is recorded on that machine, not here.',
      permissionsPairedIntro:
        'Say what MangoStudio may do on that machine. The answer is recorded there during setup, in the next step, and can be narrowed later from the card.',
      permissionsNone: 'No permissions chosen yet.',
      permissionsChosen: 'Profile: {profile}',
      permissionsChoose: 'Choose permissions',
      permissionsChange: 'Change permissions',
      provisionSshIntro:
        'MangoStudio pushes the runtime it matches, verifies its checksum, and publishes it. Running this again when the machine already has these bytes does nothing.',
      provisionPairedIntro:
        'One run over SSH: push the runtime, record your permissions, hand the machine a credential, and install the service that keeps it connected. Every step is safe to repeat.',
      provisionStartSsh: 'Install the runtime',
      provisionStartPaired: 'Set up the machine',
      toolsIntro: 'What MangoStudio found on that machine.',
      toolsProbing: 'Looking at what is installed…',
      toolsNone: 'No toolchains or agent CLIs were found there yet.',
      toolsError: 'Could not check what is installed on that machine.',
      toolsDisconnected:
        'Nothing has been probed yet — MangoStudio reads this from the machine once it is connected.',
      toolsInstallsNote:
        'Off by default. Installing on {name} needs this switch and that machine’s own permissions to agree; whichever one refuses says so.',
      libraryIntro:
        'Skills, subagents and instructions live per machine. Copying yours across is its own review — conflicts, per-destination consent, and undo — so it happens in the library.',
      libraryOpen: 'Open the library for {name}',
      libraryNotPermitted:
        'This machine’s permissions exclude the library, so there is nothing to copy across until that changes.',
      summaryReady: '{name} is set up and connected.',
      summaryPending:
        '{name} is set up. It is not connected right now — its card has the actions to finish or retry.',
      summaryTransport: 'Transport',
      summaryStatus: 'Status',
      summaryVersion: 'Runtime version',
      summaryDigest: 'Digest',
      summaryProfile: 'Profile',
      summaryUnknown: 'Not reported',
      summaryAudit: 'Run these on that machine to see what was recorded there.',
      summaryServiceCommand: 'Check the service',
    },
    versions: {
      title: 'Managed by {manager}',
      empty: 'No Node.js versions are managed by {manager} yet.',
      managerMissing: '{manager} is not installed.',
      installManager: 'Install {manager}',
      default: 'Default',
      current: 'Current',
      installLts: 'Install LTS',
      setDefault: 'Make default',
    },
    health: {
      description: 'Everything that is wrong or worth knowing, with what needs action first.',
      empty: 'Nothing needs attention.',
      emptyHint: 'Every runtime, version manager, and agent CLI is healthy.',
      scope: {
        runtime: 'Runtime',
        'version-manager': 'Version manager',
        agent: 'Agent',
      },
      // The list is split by whether anything has to be done: a failing
      // finding blocks something, a warning does not.
      needsAction: 'Needs action',
      canWait: 'Can wait',
      // Optional tools that are simply not there: nothing to do, worth knowing.
      forInformation: 'For information',
      // One muted line above the informational group when nothing fails or warns.
      nothingNeedsAction: 'Nothing needs action.',
    },
    entities: {
      title: 'Execution environments',
      description: 'Where chat tools, workspaces, and Git commands run.',
      virtual: 'Built in',
      offlineCache: 'Offline cache',
      offlineCacheHint:
        'The release could not be reached, so this started from a runtime the hub verified earlier.',
      local: {
        reason: {
          'binary-missing':
            'The Local runtime binary was not found. In a source checkout, run "cargo build -p mangostudio-runtime --locked"; for an installed hub, reinstall MangoStudio or set MANGOSTUDIO_RUNTIME_BINARY.',
        },
      },
      boundElsewhereHint:
        'Another environment record, on this hub or another one, is connected to this runtime. It takes one hub connection at a time, so this record tries again at most once a minute, without disturbing that connection. Disconnect or remove the other record to use this one.',
      connect: 'Connect',
      disconnect: 'Disconnect',
      edit: 'Edit name',
      remove: 'Remove',
      save: 'Save',
      cancel: 'Cancel',
      nameLabel: 'Environment name',
      removeConfirm: 'Remove {name}? Chats using it must be moved first.',
      removeDialogTitle: 'Remove environment',
      removeRuntimeBytes:
        'Also delete the runtime binary on that machine ({bytes}). Consent in runtime.json is left alone.',
      actionFailed: 'The environment action failed.',
      updateFailed: 'The environment could not be updated.',
      removeFailed: 'The environment could not be removed.',
      noManifest: 'Connect to inspect runtime capabilities.',
      git: 'Git {version}',
      gitUnavailable: 'Git unavailable',
      shells: 'Shells: {shells}',
      checkpoints: 'Checkpoints',
      platform: '{platform} · {arch}',
      runtimeVersionDrift:
        'This machine runs runtime {version}, which is not the release this MangoStudio ships. It still connects; update the runtime there when you can.',
      permissions: {
        title: 'Permissions',
        profile: {
          full: 'Full',
          readonly: 'Read-only',
          none: 'None',
          custom: 'Custom',
        },
        deniedIntro: 'Denied on this machine:',
        setupCommand: 'Change consent on that machine',
        allowShellHonesty:
          'allow.shell grants everything a shell can reach — the capability list below it describes intent, not a sandbox.',
        capabilities: {
          fsRead: 'Read files',
          fsWrite: 'Write files',
          shell: 'Shell',
          git: 'Git',
          probing: 'Probing',
          mcp: 'MCP',
          library: 'Library',
          checkpoints: 'Checkpoints',
          update: 'Update runtime',
          externalAgents: 'External agents',
        },
      },
      runtime: {
        title: 'Runtime',
        loading: 'Loading runtime status…',
        loadFailed: 'Could not load runtime status.',
        actionFailed: 'The runtime action failed.',
        stale: 'Stale',
        noHealth: 'No runtime health yet. Connect or install to see version and digest.',
        unenforcedContainment:
          'This runtime is too old to re-check tool paths on its own machine. A chat restricted to its working directory can still be led out of it by a symbolic link there. Upgrade the runtime.',
        version: 'v{version}',
        slot: 'slot {slot}',
        digest: '{digest}…',
        implementation: '{count} methods · build {fingerprint}',
        actions: {
          install: 'Install runtime',
          reinstall: 'Reinstall',
          upgrade: 'Upgrade',
          setup: 'Set up consent',
          download: 'Download only',
        },
        staged: {
          offer: 'Install the matching runtime ({version}, {platform}) on this machine.',
          matched: 'This machine is running the matching runtime ({version}).',
          offerHint: 'Or download it to this hub and carry it over yourself.',
          downloadOffer: 'The matching runtime for this machine is {version} ({platform}).',
          title: 'Downloaded to this hub',
          path: 'Cached file',
          verify: 'Verify it',
        },
        manual: {
          platform: 'Commands for the {platform} build.',
          platformAssumed:
            'This machine has not connected yet, so these commands assume the {platform} build. Check it matches before running them.',
          install: 'Install on that machine',
          verify: 'Verify the download',
          setup: 'Record consent',
          serviceInstall: 'Keep it running',
        },
        consent: {
          title: 'Runtime permissions',
          description: 'Choose what MangoStudio may do on {name}.',
          profileLabel: 'Profile',
          allowLabel: 'Capabilities',
          cancel: 'Cancel',
          confirm: 'Apply on {name}',
        },
      },
      pairing: {
        title: 'Pairing',
        description: 'The runtime on that machine dials MangoStudio with this credential.',
        endpointUnset:
          'MangoStudio does not know its own public address. Set `publicUrl` under `[server]` in config.toml (or PUBLIC_URL) so the command below points somewhere reachable.',
        endpointPlaceholder: '<your MangoStudio URL>/api/runtime',
        noToken: 'No pairing token yet.',
        neverSeen: 'Issued. No runtime has used it yet.',
        lastSeen: 'Last used {when}.',
        issue: 'Issue token',
        rotate: 'Issue a new token',
        revoke: 'Revoke',
        revokeConfirm:
          'Revoke this pairing token? The runtime using it disconnects immediately and cannot reconnect until you issue a new one.',
        issueFailed: 'The pairing token could not be issued.',
        revokeFailed: 'The pairing token could not be revoked.',
        tokenIssued: 'Run this on that machine.',
        tokenOnce:
          'The token is shown once. Issue a new one if you lose it — that also retires this one.',
        stepConnect: 'Connect it to MangoStudio',
        stepConnectPowerShell: 'On Windows, in PowerShell',
        stepService: 'Keep it running after you log out',
        serviceHint:
          'Upgrade this runtime from its card first, then install the service so connect survives reboot without a terminal session.',
      },
      directUrl: {
        title: 'Direct URL',
        description:
          'MangoStudio dials this address. Run mangostudio-runtime serve on that machine first.',
        baseUrlLabel: 'Base URL',
        baseUrlHint: 'http://host:port or https://… — the runtime serves WebSocket on /.',
        stepServe: 'Listen for MangoStudio on that machine',
        stepService: 'Keep it running after you log out',
        serviceHint:
          'Once serve has stored a listen address and token, upgrade this runtime from its card, then install the user service so it survives reboot.',
        tokenLabel: 'Serve token',
        tokenHint: 'Write-only. Paste the token printed by serve, or rotate it here.',
        tokenSet: 'A token is stored in the secret store.',
        tokenMissing: 'No token stored yet. Paste one to connect.',
        tokenSave: 'Save token',
        tokenRotate: 'Rotate token',
        plaintextWarning:
          'This URL is plaintext HTTP to a public host. Prefer https:// or a private/LAN address.',
        saveFailed: 'The Direct URL settings could not be saved.',
      },
      ssh: {
        title: 'SSH',
        description:
          'MangoStudio starts the runtime on that machine with your own ssh client, over a connection it opens for each session.',
        hostLabel: 'Host',
        hostInvalid: 'Give a host name or address that does not start with a dash.',
        userLabel: 'User',
        portLabel: 'Port',
        portInvalid: 'Use a port between 1 and 65535.',
        identityFileLabel: 'Identity file',
        runtimePathLabel: 'Runtime path',
        runtimePathHint: 'Where mangostudio-runtime lives on that machine. Empty means {path}.',
        dashInvalid: 'A value starting with a dash would be read as an ssh option.',
        save: 'Save',
        saveFailed: 'The SSH settings could not be saved.',
        preflightTitle: 'Check it from a terminal',
        preflightHint:
          'MangoStudio runs ssh in batch mode and cannot answer a prompt, so a host key has to be accepted by connecting once yourself.',
        preflightReach: 'Reach the machine',
        preflightRuntime: 'Find the runtime',
        reason: {
          'client-missing':
            'This machine has no ssh client on PATH. Install OpenSSH here — on Windows it is an optional feature — and connect again.',
          'auth-refused':
            'That machine refused the credentials this one offered. MangoStudio never types a password: add a key the host accepts, or point this environment at one.',
          'host-key-unverified':
            'The host key is unknown, or no longer the one in known_hosts. Connect by hand once and confirm the fingerprint; MangoStudio will not accept an unknown key for you.',
          unreachable:
            'That machine did not answer. Check the address, the port, and that this machine can route to it.',
          'runtime-missing':
            'There is no runtime at the path below on that machine. Install one there, or point this environment at the binary you already have.',
          'runtime-not-executable':
            'The runtime is there but is not executable. Run chmod +x on it on that machine.',
          'setup-pending':
            'The runtime is installed but has not been set up. Run mangostudio-runtime setup on that machine to say what it may do.',
          unknown: 'ssh could not start the runtime. Press Connect to see what it reported.',
        },
      },
      container: {
        badge: 'Isolated',
        title: 'Container',
        description:
          'Tools, workspaces and Git run inside a container started from an image you already have.',
        isolationNote:
          'The sandbox constrains the agent, not MangoStudio: it keeps a tool call away from the rest of this machine. The container engine runs as MangoStudio\u2019s own user, so this is not a boundary against whoever configures this environment.',
        ephemeralNote:
          'The container filesystem is discarded when the connection ends. Anything that has to survive \u2014 a project, a package cache, an agent home \u2014 needs a mount below.',
        imageLabel: 'Image',
        imageHint:
          'Any image that ships a shell. It is never modified: the MangoStudio runtime is mounted into it read-only at start.',
        imageInvalid: 'Use a reference like name:tag, with no spaces and no leading dash.',
        engineLabel: 'Engine',
        engine: {
          docker: 'Docker',
          podman: 'Podman',
        },
        engineReady: 'Available',
        engineUnavailable: 'Not available here',
        networkOffLabel: 'Disconnect the network',
        networkOffHint:
          'Agents usually need the network to clone, fetch and install. Turn it off for a container that must not reach anything.',
        cpusLabel: 'CPU limit',
        cpusInvalid: 'Use a number greater than zero.',
        memoryLabel: 'Memory limit (MiB)',
        memoryInvalid: 'Use a whole number of at least 64.',
        limitsHint:
          'Limits bound what a runaway process consumes. They are not part of the isolation boundary.',
        mountsLabel: 'Mounts',
        mountsHint:
          'Absolute paths, shared between this machine and the container. Paths that would give the container control of this machine are refused.',
        mountAdd: 'Add mount',
        mountHostLabel: 'Path on this machine',
        mountContainerLabel: 'Path in the container',
        mountReadonly: 'Read only',
        mountRemove: 'Remove mount',
        mountIncomplete: 'Give each mount a path on both sides, or remove the row.',
        mountTooLong: 'A mount path may be at most 1024 characters.',
        mountContainerInvalid:
          'A path in the container must start with /, with no spaces or colons.',
        mountRefusal: {
          'too-many-mounts': 'An environment may mount at most {max} paths into its container.',
          whitespace: 'The host path {host} has leading or trailing whitespace.',
          'not-absolute':
            'The host path {host} is not absolute. A relative path would be resolved against whatever directory the container engine inherited.',
          'contains-colon':
            'The host path {host} contains a colon, which separates the fields of a mount specification.',
          'engine-control':
            'Mounting {host} would give the container control of the container engine, which is a way out of the container.',
          'denied-prefix':
            "Mounting {host} would expose this machine's {prefix}, which is a way out of the container.",
          'host-root':
            "Mounting {host} would expose this machine's entire filesystem, which is a way out of the container.",
          'shadows-runtime':
            '{runtimePath} is where the MangoStudio runtime is mounted. Choose another path inside the container.',
          'shadows-image-root':
            'Mounting over / would replace the image the container is built from.',
          'duplicate-target':
            'Two mounts both target {containerPath} inside the container. Give each one its own path.',
        },
        save: 'Save container settings',
        saveFailed: 'The container settings could not be saved.',
        reason: {
          'engine-missing':
            'This machine has no container engine on PATH. Install Docker or Podman here, or point this environment at the other one.',
          'engine-unreachable':
            'The engine is installed but did not answer. Start it, and make sure the account running MangoStudio may use it.',
          'image-missing':
            'The engine could not find that image. Check the name and tag, and that this machine may pull from that registry.',
          'image-pull-failed':
            'Pulling the image did not finish. Press Connect to see what the engine reported.',
          'image-unsupported':
            'That image has no shell, so MangoStudio cannot tell which runtime build it needs. Use an image that ships one.',
          'runtime-unavailable':
            'MangoStudio has no runtime build for the platform that image runs. Use an image built for a platform this release publishes.',
          unknown:
            'The engine could not start a runtime in that image. Press Connect to see what it reported.',
        },
      },
      add: {
        trigger: 'Add environment',
        title: 'Add an environment',
        description: 'Run chat tools, workspaces, and Git in a process of their own.',
        reachLabel: 'How do you reach this machine?',
        reachLocal: 'It is this machine',
        reachWsl: 'A Linux distribution on this machine',
        reachContainer: 'In an isolated container on this machine',
        containerHint:
          'Runs tools, workspaces and Git inside a disposable container on this machine, so a tool call cannot reach the rest of it. Nothing is installed: MangoStudio mounts its runtime into an image you already have.',
        reachPaired: 'Another machine that can reach MangoStudio',
        reachDirect: 'I can reach it by URL',
        stdioHint:
          'Starts the runtime that ships with MangoStudio as a child process on this machine.',
        pairedHint:
          'The runtime on that machine dials MangoStudio, so it works from behind a router or a firewall with no inbound port open.',
        pairedNext:
          'After you add it, the card issues a pairing token and prints the two commands to run on that machine.',
        directHint:
          'MangoStudio dials a runtime that is already listening. Use this on a LAN or when you terminate TLS in front of serve.',
        directBaseUrlLabel: 'Base URL',
        directTokenLabel: 'Serve token',
        directPlaintextWarning:
          'This URL is plaintext HTTP to a public host. Prefer https:// or a private/LAN address.',
        reachSsh: 'A machine I reach over SSH',
        sshHint:
          'MangoStudio starts the runtime there with your own ssh client, so keys, your agent, ~/.ssh/config and known_hosts all apply. Nothing needs to be installed first — the environment card can push the runtime and run setup for you after you add it.',
        sshHostLabel: 'Host',
        sshUserLabel: 'User',
        sshPortLabel: 'Port',
        sshIdentityFileLabel: 'Identity file',
        sshRuntimePathLabel: 'Runtime path',
        sshRuntimePathHint:
          'Where mangostudio-runtime lives on that machine. Leave empty for the default install path.',
        sshDashInvalid: 'A value starting with a dash would be read as an ssh option.',
        sshPortInvalid: 'Use a port between 1 and 65535.',
        sshPreflight:
          'Run this once from a terminal first. It proves the machine is reachable and, on a first connection, is what puts its host key in known_hosts — a step MangoStudio deliberately will not take for you.',
        sshPreflightReach: 'Reach the machine',
        idLabel: 'Identifier',
        idHint: 'Lowercase letters, digits, and single dashes. Cannot be changed later.',
        idInvalid: 'Use lowercase letters, digits, and single dashes.',
        nameLabel: 'Display name',
        nameRequired: 'Give the environment a name.',
        binaryPathLabel: 'Runtime binary path',
        binaryPathHint: 'Leave empty to use the runtime installed beside MangoStudio.',
        cwdLabel: 'Working directory',
        cwdHint: 'Leave empty to inherit the directory MangoStudio was started in.',
        wslHint:
          'Runs tools, workspaces, and Git inside a Linux distribution on this machine. The first connection installs the runtime there and starts the distribution, so it takes a while.',
        wslDistroLabel: 'Distribution',
        wslDefault: 'Default',
        wslConfigured: 'Already used by {id}',
        wslEmpty: 'No WSL distributions are installed on this machine.',
        optional: 'Optional',
        submit: 'Add environment',
        cancel: 'Cancel',
        createFailed: 'The environment could not be created.',
        reachNewMachine: 'Set up a new machine…',
        newMachineHint:
          'Walks a machine you can reach over SSH from nothing to a working environment: the runtime, its permissions, what is installed on it, and your library.',
      },
    },
    machine: {
      description:
        'The MangoStudio process serving this page, what keeps it running, and what doctor says about the install.',
      refresh: 'Refresh',
      reconnecting: 'Waiting for the server to come back…',
      hub: {
        title: 'Hub',
        running: 'Running',
        notRunning: 'Not running',
        url: 'Address',
        pid: 'Process',
        launchLabel: 'Started',
        launch: {
          service: 'by the service',
          detached: 'in the background',
          foreground: 'in a terminal',
        },
        uptime: 'Uptime',
        version: 'Version',
        logFile: 'Log file',
        noLogFile: 'none (writes to its terminal)',
        healthLabel: 'Health',
        health: {
          ok: 'Healthy',
          unreachable: 'Not answering',
          /** Bound to one LAN address, which the loopback probe cannot reach. */
          unprobed: 'Cannot be checked from here',
        },
      },
      install: {
        title: 'Install',
        home: 'Home directory',
        logsDir: 'Logs',
        configFile: 'Config file',
        noConfigFile: 'none (defaults)',
        build: 'Build',
        standalone: 'standalone binary',
        sourceCheckout: 'source checkout',
        container: 'container',
      },
      runtime: {
        title: 'Runtime binary',
        notBuilt:
          'Not built in this source checkout. Run "cargo build -p mangostudio-runtime --locked" so Local can start.',
        missing: 'not found; Local cannot start',
        versionMismatch:
          'The runtime binary reports a different version than the hub. Local and stdio environments will refuse to connect until both match.',
      },
      hostSlot: {
        title: 'Host consent',
        absent: 'no consent file, so everything is allowed',
        profile: {
          full: 'Full access',
          readonly: 'Read only',
          none: 'Nothing allowed',
          custom: 'Custom',
        },
      },
      doctor: {
        title: 'Doctor',
        summary: '{warnings} warnings, {failures} failures',
        clear: 'Every check passed.',
        /**
         * One template per doctor label or detail, keyed by the key the check
         * carries on the wire (`MachineCheck.labelKey` / `detailKey`). The CLI
         * prints these same English strings, so an edit here changes the
         * terminal output too. A `{param}` that holds text from outside the
         * product (an OS error, a path, a version) is filled in as is.
         */
        checks: {
          'core.label.homeDirectory': 'Home directory',
          'core.label.logsDirectory': 'Logs directory',
          'core.label.runDirectory': 'Run directory',
          'core.label.config': 'Config',
          'core.label.database': 'Database',
          'core.label.frontend': 'Frontend',
          'core.label.authSecret': 'Auth secret',
          'core.label.instance': 'Instance',
          'core.label.runtime': 'Runtime',
          'core.label.runtimeBinary': 'Runtime binary',
          'core.label.runtimeSlot': 'Runtime slot ({slot})',
          'core.label.runtimeCache': 'Runtime cache',
          'core.label.sshClient': 'SSH client',
          'core.label.serverBuild': 'Server build',
          'core.label.checkoutBuild': 'Checkout build',
          'core.label.frontendBuild': 'Frontend build',
          'core.detail.directoryWritable': '{path} (writable)',
          'core.detail.directoryNotWritable': '{path} (not writable)',
          'core.detail.directoryWillBeCreated': '{path} (will be created)',
          'core.detail.directoryParentNotWritable': '{path} (parent not writable)',
          'core.detail.configFile': '{host}:{port} ({path})',
          'core.detail.configDefaults': '{host}:{port} (defaults)',
          'core.detail.databaseInMemory': 'in-memory',
          'core.detail.databasePath': '{path}',
          'core.detail.frontendPresent': '{path} (present)',
          'core.detail.frontendMissing': '{path} (missing — API only)',
          'core.detail.frontendEmbeddedFiles': 'embedded in binary ({count} files)',
          'core.detail.frontendEmbeddedInServer': 'embedded in running server binary',
          'core.detail.authSecretInvalid': '{message}',
          'core.detail.authSecretSet': 'set ({minLength}+ characters)',
          'core.detail.instanceNotRunning': 'not running',
          'core.detail.instanceStale': 'stale state file (PID {pid})',
          'core.detail.instanceRunning': 'running (PID {pid}, port {port}, health not probed)',
          'core.detail.runtimeStandalone': 'v{version} {platform}-{arch} standalone',
          'core.detail.runtimeDevelopment': 'v{version} {platform}-{arch} dev',
          'core.detail.runtimeBinaryNotBuilt':
            'not built in this source checkout; Local cannot start. Run "{command}" from the repository root',
          'core.detail.runtimeBinaryMissing':
            'missing at {path}; Local cannot start. Reinstall MangoStudio so it ships beside the hub, or set MANGOSTUDIO_RUNTIME_BINARY',
          'core.detail.runtimeBinaryNoVersion': '{path} did not report a version ({reason})',
          'core.detail.runtimeBinaryNoVersionUnknown':
            '{path} did not report a version (unknown reason)',
          'core.detail.runtimeBinaryMismatch':
            'v{version} does not match hub v{hubVersion}; reinstall so both come from one release',
          'core.detail.runtimeBinaryOk': 'v{version} at {path}',
          'core.detail.runtimeSlotUnreadable':
            '{file} in {directory} {error}; run "{command}" to rewrite it',
          'core.detail.runtimeSlotPending': 'waiting for consent; run "{command}" on that machine',
          'core.detail.runtimeSlotConfigured': '{profile}  {directory}',
          'core.detail.runtimeSlotConfiguredVersion': 'v{version}  {profile}  {directory}',
          'core.detail.runtimeSlotDenied': '{profile} (denied: {denied})  {directory}',
          'core.detail.runtimeSlotDeniedVersion':
            'v{version}  {profile} (denied: {denied})  {directory}',
          'core.detail.runtimeCacheEmpty': 'empty  {directory}',
          'core.detail.runtimeCacheVersions': '{versions}  {directory}',
          'core.detail.sshClientMissing': 'no ssh on PATH; SSH environments cannot start',
          'core.detail.sshClientNoVersion': '{path} did not report a version ({reason})',
          'core.detail.sshClientNoVersionUnknown':
            '{path} did not report a version (unknown reason)',
          'core.detail.sshClientOk': '{version}  {path}',
          'core.detail.buildStampClean': '{sha} (built {builtAt}, clean, {buildType})',
          'core.detail.buildStampDirty': '{sha} (built {builtAt}, dirty, {buildType})',
          'core.detail.buildStampDirtyUnknown':
            '{sha} (built {builtAt}, dirty unknown, {buildType})',
          'core.detail.serverBuildMissing': 'running server did not report build metadata',
          'core.detail.checkoutBuildDiffers':
            'checkout {checkout} differs from server {server}; restart or rebuild if unexpected',
          'core.detail.frontendBuildMissing': '{path} missing; rebuild frontend assets to compare',
          'core.detail.frontendBuildDiffers': 'frontend {frontend} differs from server {server}',
          'install.label.installedVia': 'Installed via',
          'install.detail.installedVia': '{manager} · channel {channel}',
          'install.detail.installedViaLegacy':
            '{manager} · channel {channel} · legacy layout, run mangostudio upgrade to migrate',
          'update.label.update': 'Update',
          'update.detail.disabled': 'checks disabled',
          'update.detail.skippedEnv': 'skipped (NO_UPDATE_NOTIFIER|DO_NOT_TRACK|CI)',
          'update.detail.skippedDev': 'skipped (development build)',
          'update.detail.notChecked': 'not checked yet',
          'update.detail.checkFailed': 'check failed ({error})',
          'update.detail.available': '{version} available — run: {command}',
          'update.detail.availableUnnamed': 'a newer build available — run: {command}',
          'update.detail.upToDate': 'up to date ({version}, checked {hours}h ago)',
          'cursor.label.connector': 'Cursor connector',
          'cursor.detail.deprecated':
            'Deprecated provider. Use the Cursor CLI runner in the chat runner selector; this key no longer runs turns.',
        },
      },
      logs: {
        title: 'Log',
        none: 'No log file: this server writes to the terminal it was started in.',
        readLocally:
          'Open this page from the machine the hub runs on, or run "mangostudio logs" there.',
        empty: 'The log file is empty.',
        truncated: 'Last {count} lines of {file}',
      },
    },
  },
};
