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
  },
};
