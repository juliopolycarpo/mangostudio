import type { CoreMessages } from './types';

/**
 * The eager English dictionary: every namespace except the deferred ones
 * (`en-settings.ts`, `en-onboarding.ts`; see `DeferredNamespace` in `types.ts`),
 * and for `environments`, `git`, `github` and `library` only the keys listed in
 * `EagerFeatureKeys`; the rest are in `en-<namespace>.ts`, which the feature's lazy
 * chunk imports. A key that something outside that chunk reads belongs here.
 */
export const messages: CoreMessages = {
  auth: {
    loginTitle: 'Sign in',
    signupTitle: 'Create account',
    emailLabel: 'Email',
    emailPlaceholder: 'you@email.com',
    passwordLabel: 'Password',
    passwordHint: 'At least 8 characters',
    nameLabel: 'Name',
    namePlaceholder: 'Ada Lovelace',
    loginButton: 'Sign in',
    loginLoading: 'Signing in…',
    signupButton: 'Create account',
    signupLoading: 'Creating…',
    loginLink: 'Sign in',
    signupLink: 'Create account',
    noAccount: 'Don’t have an account?',
    hasAccount: 'Already have an account?',
    loginError: 'Could not sign in. Check your email and password, then try again.',
    signupError: 'Could not create the account. Check the details and try again.',
    logoutButton: 'Sign out',
    logoutLoading: 'Signing out…',
    logoutError: 'Logout failed. Please try again.',
  },

  chat: {
    newChat: 'New chat',
    /** What a chat is called until its first prompt names it. */
    untitled: 'New chat',
    empty: 'Start a chat',
    deleted: 'Chat deleted',
    newChatRunnerFailed: 'Could not start the chat on that runner. Try again.',
    newChatWorkdirFailed: 'Could not start the chat in that folder. Try again.',
    editTitle: 'Edit title',
    deleteTitle: 'Delete chat',
    deleteConfirmTitle: 'Delete this chat?',
    deleteConfirmDescription: 'This permanently deletes the chat and all its messages.',
    deleteCancel: 'Cancel',
    deleteFailed: 'Could not delete the chat. Try again.',
    sectionLabel: 'Chats',
    streaming: 'Generating…',
    input: {
      send: 'Send',
      generate: 'Generate',
      stop: 'Stop',
      placeholder: 'Ask the AI model anything…',
      /** Used instead of `placeholder` when a vendor CLI runs the chat. */
      placeholderRunner: 'Message {agent}…',
      createImages: 'Create images',
      createImagesHint: 'Hint to the model to use the image generation tool',
      selectAgent: 'Select agent',
      agentsLoading: 'Loading agents…',
      mcpMenuButton: 'MCP prompts and resources',
      mcpPromptsSection: 'Prompts',
      mcpResourcesSection: 'Resources',
      mcpMenuEmpty: 'Your MCP servers expose no prompts or resources.',
      mcpNeedsChat: 'Open a chat before attaching resources.',
      mcpAttachFailed: 'Could not attach the resource. Try again.',
      mcpInsertFailed: 'Could not insert the prompt. Try again.',
      mcpLoadFailed: 'Could not load MCP prompts and resources.',
      slashMenuLabel: 'Slash commands',
      slashMenuEmpty: 'No command matches.',
      slashMenuLoading: 'Looking for commands…',
      /**
       * Where a name came from. `session` is the running agent's own answer and
       * `library` is a file on disk it has not confirmed reading yet — a
       * distinction worth keeping, because only the first one is proof.
       */
      slashMenuOrigin: {
        session: 'session',
        library: 'on disk',
        skill: 'skill',
      },
      mcpPromptArgsTitle: 'Prompt arguments',
      mcpPromptInsert: 'Insert',
      mcpPromptCancel: 'Cancel',
      mcpArgRequired: 'Required',
      removeAttachment: 'Remove attachment',
      selectEnvironment: 'Select execution environment',
      environmentsLoading: 'Loading environments…',
      environmentUpdateFailed: 'The execution environment could not be changed.',
      dropHint: 'Drop to attach',
      attachUploading: 'Uploading {name}…',
      attachFailed: 'Could not attach {name}.',
      attachNeedsChat: 'Open a chat before attaching files.',
      showControls: 'Show chat controls',
      hideControls: 'Hide chat controls',
      agentLabel: 'agent',
      agentLocked:
        'Locked after the first turn — pick a runner in the header to continue in a new chat.',
      modelLabel: 'model',
      environmentLabel: 'env',
      environmentLocked:
        'Locked once the first turn starts — this chat keeps the environment it started on.',
      environmentOnlyOne: 'The only environment so far. Add another from Environments.',
      /**
       * The status line's key for reasoning effort. Short on purpose: the
       * picker's own `Reasoning effort` heading is too long for a strip that
       * already carries five other keys, and squeezed the value to one letter.
       */
      effortLabel: 'effort',
    },
    capabilities: {
      button: 'Capabilities',
      title: 'Active capabilities',
      loadError: 'Could not load capabilities. Try again.',
      needsChat: 'Open a chat to inspect capabilities.',
      builtinsSection: 'Built-in tools',
      mcpSection: 'MCP servers',
      skillsSection: 'Skills',
      enabledCount: '{enabled}/{total} enabled',
      toolCount: '{count} tools',
      stateEnabled: 'Enabled',
      stateDisabled: 'Disabled',
      stateUnavailable: 'Unavailable',
      mcpEmpty: 'No MCP servers configured.',
      skillsEmpty: 'No skills discovered.',
      showEnabled: 'Show {count} enabled',
      hideEnabled: 'Hide {count} enabled',
      manageTools: 'Tool settings',
      manageMcp: 'MCP settings',
      manageSkills: 'Skill settings',
      manageAgent: 'Agent settings',
      reasons: {
        'agent-tools-disabled': 'the agent profile disables tools',
        'agent-allowlist': 'not in the agent tool allowlist',
        'tool-setting-disabled': 'disabled in tool settings',
        'name-over-provider-limit': 'name exceeds the provider limit',
        'environment-unsupported': 'not supported by the selected environment',
        'runtime-denied': 'refused by {environmentName}',
        'server-disabled': 'server is disabled',
        'server-unavailable': 'server is unavailable',
        'delegation-disabled': 'delegation is disabled in multi-agent settings',
        'skill-invalid': 'skill is invalid',
        'skill-disabled': 'disabled in skill settings',
        'skill-shadowed': 'shadowed by a higher-precedence source',
        'skill-precedence-unverified': 'a higher-priority skill location could not be scanned',
        'skill-tool-disabled': 'the skill tool is not active',
      },
      /** Substituted for the hub's own machine, whose API name is not copy. */
      localEnvironment: 'this machine',
      health: {
        connected: 'connected',
        connecting: 'connecting',
        disconnected: 'disconnected',
        error: 'error',
        disabled: 'disabled',
      },
    },
    feed: {
      emptyTitle: 'Start a chat or create an image',
      emptySubtitle: 'Turn on Create images to generate art',
      loadingOlder: 'Loading earlier messages…',
      generatingImage: 'Generating image…',
      statusGenerating: 'Generating',
      statusThinking: 'Thinking',
      statusResponding: 'Responding',
      statusWorking: 'Working',
      statusAwaitingUser: 'Waiting for you',
      modelFallback: 'AI model',
      modelStatus: '{status} with {model}',
      download: 'Download',
      imageUnavailable: 'Image no longer available',
      imageUnavailableHint: 'The image was deleted, moved, or is not accessible yet.',
      generatedImageAlt: 'Generated image',
      referenceImageAlt: 'Reference image',
      imageGenerationFailed: 'Image generation failed',
      styleParams: 'Style parameters',
      thoughtFor: 'Thought for {time}',
      generatedIn: 'Generated in {time}',
      respondedIn: 'Responded in {time}',
      failedAfter: 'Failed after {time}',
      stoppedAfter: 'Stopped after {time}',
      toolLoopRoundsOne: 'Stopped after {count} round of tool calls.',
      toolLoopRoundsOther: 'Stopped after {count} rounds of tool calls.',
      noResponse: 'No response',
      neuralDiffusionPath: 'Using neural diffusion path.',
      createImageBadge: 'Create image',
      mcpImageAlt: 'Image returned by an MCP tool',
      mcpResourceFile: 'Resource file',
      mcpMediaSource: 'From {source}',
      subagentPendingName: 'Subagent',
      subagentStatusCompleted: 'Completed',
      subagentStatusFailed: 'Failed',
      subagentStatusAborted: 'Aborted',
      subagentStatusTimeout: 'Timed out',
      subagentTools: '{count} tools',
      subagentNoTools: 'No tools',
      subagentLastMessage: 'Last message',
      subagentMessages: 'Messages',
      subagentToolCalls: 'Tool calls',
      subagentLifecycle: 'Lifecycle',
      subagentLifecycleDelegationStarted: 'Delegation started',
      subagentLifecycleDelegationCompleted: 'Delegation completed',
      subagentLifecycleDelegationFailed: 'Delegation failed',
      subagentLifecycleAttempt: 'Attempt {attempt}',
      subagentLifecycleRecovered: 'Recovered response',
      subagentLifecycleTimeout: 'Timed out',
      subagentLifecycleFallback: 'Fallback response created',
    },
    question: {
      title: 'The AI needs your decision',
      submit: 'Send answers',
      ownAnswerPlaceholder: 'Or write your own answer…',
      multiSelectHint: 'Select one or more options',
      answersIntro: 'My answers to your questions:',
      answered: 'Answered',
    },
    elicitation: {
      title: 'An MCP server needs your input',
      fromServer: 'From {server}',
      submit: 'Submit',
      decline: 'Decline',
      cancel: 'Cancel',
      answered: 'Responded',
      declined: 'Declined',
      cancelled: 'Cancelled',
      requiredHint: 'Required',
      multiSelectHint: 'Select one or more options',
      booleanTrue: 'Yes',
      booleanFalse: 'No',
      submitError: 'Could not send your response. Try again.',
    },
    todo: {
      title: 'Task list',
      summary: '{completed}/{total} done',
      statusPending: 'Pending',
      statusInProgress: 'In progress',
      statusCompleted: 'Completed',
      empty: 'Task list cleared',
      panelCurrent: 'current: {task}',
      panelExpand: 'Show tasks',
      panelCollapse: 'Hide tasks',
    },
    context: {
      label: 'Context',
      title: 'Context is nearly full',
      tokens: '~{used} / {limit} tokens',
      modeStateful: 'Stateful',
      modeStatelessLoop: 'Stateless loop',
      modeLabel: 'Mode',
      modeReplay: 'Replay',
      modeCompacted: 'Compacted',
      modeDegraded: 'Degraded',
      warning: 'This chat is approaching the model context limit.',
      danger: 'MangoStudio may need to compact or leave stateful mode.',
      critical: 'This chat can no longer remain stateful on the current provider.',
      keepHistory: 'Original messages stay in chat history by default.',
      compactAction: 'Compact and continue',
      newChatAction: 'Start summarized chat',
      continueAction: 'Continue anyway',
      compactPending: 'Compacting…',
      compactedSuccess: 'Chat compacted',
      summarizedChatSuccess: 'Summarized chat started',
      compactFailed: 'Failed to compact chat',
      summarizedChatFailed: 'Failed to start summarized chat',
    },
    recovery: {
      title: 'Agent turn interrupted',
      detail:
        'MangoStudio saved the latest durable progress. Review tool outcomes before resuming.',
      completedCalls: 'Completed tools ({count})',
      incompleteCalls: 'Incomplete tools ({count})',
      retryHint:
        'Only selected incomplete tools may be retried. Read-only tools are selected by default.',
      safeRead: 'Read-only',
      confirmationRequired: 'May change data',
      unknownSafety: 'Unknown safety',
      failed: 'failed',
      resume: 'Resume turn',
      resuming: 'Resuming…',
      dismiss: 'Dismiss',
      dismissing: 'Dismissing…',
      resumeUserMessage: 'Continue the interrupted turn from its saved progress.',
      actionFailed: 'Could not update the interrupted turn. Try again.',
      reason: {
        clientDisconnect: 'The client disconnected while the agent was working.',
        serverRestart: 'The server restarted while the agent was working.',
        providerError: 'The provider stopped the turn with an error.',
        userCancelled: 'The turn was stopped before it completed.',
        toolLoopExhausted: 'The turn reached its tool iteration limit.',
        unknown: 'The turn ended before completion could be confirmed.',
      },
    },
    deprecatedModel: {
      title: 'MangoStudio no longer runs {provider} models',
      body: 'This chat is set to {model}. {provider} now runs as its own CLI agent that owns its tools and approvals, so continuing there means a new chat — this one keeps its history. Pick another model below to stay in this chat.',
      continueInNewChat: 'Continue in a new chat with {target} CLI',
      runnerUnavailable:
        'The {target} CLI is not available in this environment. Install and sign in, or pick another model below.',
      dismiss: 'Dismiss',
      forkFailed: 'Could not start the new chat. Try again.',
    },
    fallback: {
      toReplay: 'Stateful continuation is no longer available. Continuing with transcript replay.',
      generic: 'Chat mode changed from {from} to {to}.',
    },
    continuation: {
      title: {
        providerChanged:
          '{fromProvider} {fromMode} state cannot be reused by {provider}. Replayed transcript and started {provider} {toMode} continuation.',
        modelChanged: 'Model changed to {model}. Replayed transcript on {provider} {toMode}.',
        systemPromptChanged: 'System prompt changed. Replayed transcript on {provider} {toMode}.',
        toolsetChanged: 'Toolset changed. Replayed transcript on {provider} {toMode}.',
        agentChanged: 'Agent changed. Replayed transcript on {provider} {toMode}.',
        agentRuntimeChanged: 'Agent settings changed. Replayed transcript on {provider} {toMode}.',
        cursorExpired: '{provider} {fromMode} cursor expired. Falling back to transcript replay.',
        cursorInvalid:
          '{provider} {fromMode} cursor was invalidated. Falling back to transcript replay.',
        toolResultCursorLoss:
          '{provider} {fromMode} cursor was lost during tool execution. Response may be incomplete.',
        envelopeMalformed:
          'Stored continuation state was unreadable. Restarting with transcript replay.',
      },
      recovered: '(recovered)',
      notRecovered: '(not recovered)',
    },
    cursorLost: 'Cursor lost — fallback to {detail}',
    toolLoopExhausted: 'Tool loop limit reached',
    copyCode: 'Copy code',
    codeCopied: 'Copied!',
    copyMessage: 'Copy message',
    messageCopied: 'Message copied!',
    fileCheckpoints: {
      revert: 'Revert file changes',
      reverting: 'Reverting…',
      confirmTitle: 'Revert this message’s file changes?',
      confirmBody:
        'This restores or removes files touched during this assistant turn. Changes you made afterward may block the revert.',
      confirmAction: 'Revert files',
      shellCaptureNote:
        'Shell command changes are found by comparing files before and after, so this revert can also undo edits another program made while a command ran.',
      cancel: 'Cancel',
      uncheckpointedShell:
        'This turn also ran shell commands. Any changes made by shell commands are not checkpointed and will not be reverted.',
      uncheckpointedMcp:
        'This turn also ran MCP tools. Any files they changed are not checkpointed and will not be reverted.',
      uncheckpointedBoth:
        'This turn also ran shell commands and MCP tools. Any changes made by shell commands or MCP tools are not checkpointed and will not be reverted.',
      // One/Other pairs: the revert result is restated per combination of
      // uncovered sources (see `uncheckpointed-copy.ts`), and each sentence
      // agrees with its count.
      revertedOne: 'Reverted {count} file.',
      revertedOther: 'Reverted {count} files.',
      revertedWithShellOne:
        'Reverted {count} file. Any changes made by shell commands were not reverted.',
      revertedWithShellOther:
        'Reverted {count} files. Any changes made by shell commands were not reverted.',
      revertedWithMcpOne: 'Reverted {count} file. Any changes made by MCP tools were not reverted.',
      revertedWithMcpOther:
        'Reverted {count} files. Any changes made by MCP tools were not reverted.',
      revertedWithBothOne:
        'Reverted {count} file. Any changes made by shell commands or MCP tools were not reverted.',
      revertedWithBothOther:
        'Reverted {count} files. Any changes made by shell commands or MCP tools were not reverted.',
      conflict: 'Could not revert: one or more files changed on disk since this message completed.',
      outsideWorkdir:
        'Could not revert: this message touched files outside the working directory, and tools are restricted to it.',
      failed: 'Could not revert file changes.',
    },
    scrollToBottom: 'Scroll to bottom',
    systemEvents: {
      chatCompacted: 'Context compacted into a summary',
      summaryHandoff: 'This chat started from a summarized handoff',
      cursorInternalToolCall: 'Cursor used {tool}',
      // The marker an adopted chat opens with. It names the vendor because the
      // history above this line is theirs and is not shown here.
      externalSessionAdopted: 'Continuing a {vendor} session started outside MangoStudio',
    },
  },

  home: {
    nav: 'Home',
    // One count of uncommitted files for every Home card, so the dashboard and
    // the new-chat hub never word the same fact two ways.
    filesChangedOne: '{count} file changed',
    filesChangedOther: '{count} files changed',
    greeting: {
      morning: 'Good morning, {name}.',
      afternoon: 'Good afternoon, {name}.',
      evening: 'Good evening, {name}.',
      morningAnonymous: 'Good morning.',
      afternoonAnonymous: 'Good afternoon.',
      eveningAnonymous: 'Good evening.',
      subtitle: 'Your workspace is ready. Here is where it stands.',
      dashboardSubtitle: 'Every workspace, machine and agent on this account.',
    },
    workspaces: {
      label: 'Workspaces',
      clean: 'clean tree',
      // `*One` / `*Other` pairs: the component picks by count (`usePlural`).
      sessionsOne: '{count} chat',
      sessionsOther: '{count} chats',
      noSessions: 'No chat here yet',
      continueLatest: 'Continue',
      continueSession: 'Continue {title}',
      newChatHere: 'New chat here',
      newChatHereIn: 'New chat in {folder}',
      moreOne: 'And {count} more folder.',
      moreOther: 'And {count} more folders.',
      empty: 'No folders yet',
      emptyHint: 'Start a chat and point it at a project to see it here.',
    },
    machines: {
      label: 'Machines',
      // Not "Open environments": the fault card beside this one already uses
      // that, and two links with one name on one screen is a coin toss.
      open: 'Manage machines',
      navAlertsOne: '{count} alert',
      navAlertsOther: '{count} alerts',
    },
    toolchain: {
      label: 'Toolchain',
      open: 'Open health',
      empty: 'Nothing detected on this machine yet.',
      allClear: 'Everything the toolchain reports is ready.',
    },
    /**
     * The card only appears when reviews are waiting, so there is no empty-state
     * key: an empty card is the one thing this dashboard promises not to show.
     */
    github: {
      label: 'Reviews waiting',
      row: '{repo} #{number}',
    },
    workspace: {
      label: 'Workspace',
      cleanTree: 'clean tree',
      synced: 'synced with origin',
      noUpstream: 'no upstream',
      detached: 'detached HEAD at {hash}',
      noWorkdir: 'This chat does not point at a folder yet.',
      chooseWorkdir: 'Choose a folder',
      notARepo: 'This folder is not a Git repository.',
      unavailable: 'Git is not available in this environment.',
    },
    agents: {
      label: 'Agents',
      empty: 'No agent CLI detected in this environment.',
      manage: 'Manage agents',
      quotaRefresh: 'Refresh quota',
      sessionsThisWeek: '{count} this week',
      /** The short words an agent row's badge shows; the full reason stays in the title. */
      ready: 'Ready',
      notInstalled: 'Not installed',
      signedOut: 'Signed out',
      needsApproval: 'Needs approval',
      unavailable: 'Unavailable',
      unconfirmed: 'Unconfirmed',
    },
    skills: {
      label: 'Skills',
      labelDivergentOne: 'Skills — {count} divergence',
      labelDivergentOther: 'Skills — {count} divergences',
      divergenceBody: 'Different version in {outliers} than in {agreeing}.',
      divergenceBodyNoMajority: 'Different copies of this skill in {targets}.',
      moreOne: '{count} more skill diverges.',
      moreOther: '{count} more skills diverge.',
      propagate: 'Propagate',
      viewDiff: 'View diff',
      singleTargetOne: '{count} skill lives in a single agent.',
      singleTargetOther: '{count} skills live in a single agent.',
      openLibrary: 'Open in the library',
    },
    /**
     * The same card scanning every kind. Its own sentences rather than a noun
     * interpolated into the skills copy: "1 skill lives in a single agent" and
     * "1 resource lives in a single agent" agree in more languages than they
     * disagree only by accident, and a locale cannot fix a sentence it was
     * handed a noun to slot into.
     */
    library: {
      label: 'Library',
      labelDivergentOne: 'Library — {count} divergence',
      labelDivergentOther: 'Library — {count} divergences',
      divergenceBody: 'Different version in {outliers} than in {agreeing}.',
      divergenceBodyNoMajority: 'Different copies of this resource in {targets}.',
      moreOne: '{count} more resource diverges.',
      moreOther: '{count} more resources diverge.',
      propagate: 'Propagate',
      viewDiff: 'View diff',
      singleTargetOne: '{count} resource lives in a single agent.',
      singleTargetOther: '{count} resources live in a single agent.',
      openLibrary: 'Open in the library',
    },
    uncommitted: {
      label: 'Uncommitted work',
      unpushedOne: '{count} unpushed',
      unpushedOther: '{count} unpushed',
      moreOne: 'And {count} more chat.',
      moreOther: 'And {count} more chats.',
      open: 'Open {title}',
    },
    environments: {
      label: 'Environments',
      disconnected: 'not connected',
      failed: 'failed',
      open: 'Open environments',
    },
    starters: {
      label: 'Start with',
      reviewChanges: 'Review my uncommitted changes',
      commitMessage: 'Write the commit message for what changed',
      branchSummary: 'Summarize what changed on this branch',
      explainCodebase: 'Explain this codebase to me',
      writeTests: 'Write tests for the code that changed recently',
      explainConcept: 'Explain a complex concept simply',
      pythonScript: 'Write a Python script to…',
      debug: 'Help me debug a problem',
    },
    activity: {
      label: 'Activity',
      empty: 'Nothing here yet.',
      sinceLastVisit: 'Since your last visit',
      newCountOne: '{count} new',
      newCountOther: '{count} new',
      today: 'Today',
      yesterday: 'Yesterday',
      chatCreated: 'Started {title}',
      turnCompleted: '{runner} answered in {title}',
      commitCreated: 'Committed "{subject}"',
      commitCreatedOnBranch: 'Committed "{subject}" on {branch}',
      branchPushed: 'Pushed {branch} to {remote}',
      propagationApplied: 'Propagated {name} to {targets}',
      propagationAppliedNoTargets: 'Propagated {name}',
      quotaRefreshed: '{target} quota at {used}%, was {previous}%',
      environmentConnected: '{name} reconnected',
      environmentDisconnected: '{name} disconnected',
      environmentError: '{name} could not connect',
      // The short forms of an event's age, for a fixed-width column: "now", "5m", "2h".
      timeNow: 'now',
      timeMinutes: '{count}m',
      timeHours: '{count}h',
      timeDays: '{count}d',
      timeMonths: '{count}mo',
      timeYears: '{count}y',
    },
  },

  studio: {
    title: 'Studio',
    subtitle: 'Make images, and look back at the ones that came out of here.',
    generate: {
      label: 'Create images',
      description: 'Opens the chat with the image tool already on. Describe what you want.',
      action: 'Start in chat',
    },
    recent: {
      label: 'Recent',
      empty: 'Nothing generated yet.',
      error: 'Could not load recent images.',
      viewAll: 'View all',
    },
  },

  gallery: {
    title: 'Gallery',
    empty: 'Your creations will appear here.',
    download: 'Download full image',
    downloadImage: 'Download image',
    viewImage: 'View image: {prompt}',
    lightboxLabel: 'Image preview',
    close: 'Close image',
  },

  workspace: {
    title: 'Working directory',
    description:
      'Choose a folder on the server filesystem. Agent file tools resolve relative paths from this folder.',
    serverLabel: 'Server',
    home: 'Home',
    places: 'Places',
    recent: 'Recent',
    noRecent: 'No recent folders',
    manualPathLabel: 'Server path',
    manualPathPlaceholder: '/path/to/project',
    browse: 'Open',
    showHidden: 'Show hidden',
    hideHidden: 'Hide hidden',
    parent: 'Parent folder',
    selectFolder: 'Select this folder',
    useDefault: 'Use default',
    close: 'Close',
    loading: 'Loading folders…',
    empty: 'No subfolders found.',
    truncatedNotice:
      'This folder has too many subfolders to list. Showing the first {count}; type a full path above to open one that is not shown.',
    loadError: 'This folder could not be opened.',
    selectionError: 'The working directory could not be set.',
    validationError: 'This path cannot be used as a working directory.',
    validationReasons: {
      notFound: 'The folder does not exist on the server.',
      notDirectory: 'The path does not point to a folder.',
      permissionDenied: 'The server does not have permission to access this folder.',
    },
    chooseWorkdir: 'Choose working directory',
    changeWorkdir: 'Change working directory: {name}',
    settingsLabel: 'Default working directory',
    settingsDescription:
      'New Agent-mode chats use this folder until you choose a different one for the chat.',
    defaultLabel: 'Default folder',
    defaultEmpty: 'No default folder selected',
    changeDefault: 'Choose folder',
    clearDefault: 'Clear default',
    restrictToolsLabel: 'Restrict tools to working directory',
    restrictToolsDescription:
      'When enabled, built-in file and shell tools cannot target paths outside the working directory. This is a guardrail, not a sandbox — shell commands can still access other paths on the server.',
    restrictToolsInherit: 'Use workspace default ({state})',
    restrictToolsOn: 'Restricted to working directory',
    restrictToolsOff: 'Not restricted',
    restrictToolsGlobalOn: 'on',
    restrictToolsGlobalOff: 'off',
    restrictToolsChatOverrideLabel: 'Tool path restriction for this chat',
    sidePanelTitle: 'Agent side panel',
    sidePanelDescription:
      'Choose which workspace panels appear in Agent mode and arrange their dock order.',
    widthLabel: 'Width',
    widthDefaultHint: 'Drag the sidebar edge to change it. Default {width}px.',
    sidePanelResetWidth: 'Reset width',
    sidePanelShow: 'Show {panel}',
    sidePanelMoveUp: 'Move {panel} up',
    sidePanelMoveDown: 'Move {panel} down',
    sidePanelOpen: 'Open agent side panel',
    sidePanelCollapse: 'Collapse agent side panel',
    sidePanelClose: 'Close agent side panel',
    sidePanelResize: 'Resize agent side panel',
    sidePanelNavigation: 'Agent panels',
    sidePanelSwitch: 'Show {panel} panel',
    chatSidebarTitle: 'Chat sidebar',
    chatSidebarDescription: 'Drag the sidebar edge on desktop to show longer chat titles.',
    chatSidebarResetWidth: 'Reset sidebar width',
    chatSidebarResize: 'Resize chat sidebar',
    breadcrumbIn: 'in',
    breadcrumbDirty: 'Uncommitted changes',
    breadcrumbDirtyShort: 'Modified',
  },

  sidebar: {
    groups: {
      today: 'Today',
      yesterday: 'Yesterday',
      thisWeek: 'This week',
    },
    searchPlaceholder: 'Search chats…',
    searchNoResultsHint: 'Try another title, folder or agent.',
    clearSearch: 'Clear search',
    loadingMore: 'Loading more chats…',
    loadMore: 'Load more chats',
    currentChatGroup: 'Open chat',
    // Terminal-style harness labels — brand names, identical in both locales.
    runner: {
      mango: 'mango',
      codex: 'codex',
      claude: 'claude',
      cursor: 'cursor',
    },
    git: {
      dirtyOne: '{count} uncommitted change',
      dirtyOther: '{count} uncommitted changes',
      // Spells out the ↑/↓ glyphs for anyone who cannot see them.
      sync: '{ahead} ahead, {behind} behind',
    },
  },

  commandPalette: {
    title: 'Command palette',
    open: 'Open command palette',
    placeholder: 'Search chats, actions and settings…',
    emptyHint: 'Try a chat title, a folder, an agent or a settings tab.',
    sections: {
      sessions: 'Chats',
      actions: 'Actions',
      navigate: 'Go to',
      environments: 'Environments',
    },
    hints: {
      navigate: 'navigate',
      run: 'run',
      sections: 'sections',
    },
    keys: {
      escape: 'Esc',
    },
    actions: {
      newChatWith: 'New chat with {runner}',
      switchToLight: 'Switch to light theme',
      switchToDark: 'Switch to dark theme',
      chooseWorkdir: 'Choose working directory',
      refreshQuota: 'Refresh {runner} quota',
      // The rail has no keyboard shortcut for switching panels, so the palette
      // is the accessible path — not a nicety.
      openGithubPanel: 'Open GitHub panel',
      reviewRequests: 'Review requests waiting on me',
    },
  },

  git: {
    title: 'Repository',
    refresh: 'Refresh repository state',
    remote: {
      fetch: 'Fetch',
      fetching: 'Fetching…',
      pull: 'Pull {count} commits',
      pulling: 'Pulling…',
      push: 'Push {count} commits',
      publish: 'Publish branch',
      pushing: 'Pushing…',
      fetched: 'Remote refs updated.',
      pulled: 'Branch fast-forwarded.',
      pushed: 'Branch pushed.',
      actionError: 'The remote operation failed.',
      syncSummary: '↑{ahead} ↓{behind}',
      authRequired:
        'Git authentication is required. Check the credential helper or SSH agent on the server.',
      nonFastForward:
        'This branch cannot fast-forward. Resolve the divergence in a terminal, then refresh.',
      historyDiverged:
        'Remote history diverged. Fetch and resolve it in a terminal before pushing again.',
      forcePush: 'Force push (with lease)',
      forcePushConfirmTitle: 'Force pushing rewrites the remote',
      forcePushConfirmHint:
        'The push uses --force-with-lease: it is refused if someone published commits you have not fetched. Only continue when this branch is yours.',
      forcePushConfirm: 'Force push',
      forcePushCancel: 'Cancel',
      forcePushed: 'Branch pushed with force-with-lease.',
    },
    diff: {
      back: 'Close diff',
      loading: 'Loading diff…',
      loadError: 'The file diff could not be loaded.',
      empty: 'No textual changes for this file.',
      binary: 'Binary file changed. A text preview is not available.',
      view: 'View diff for {path}',
      staged: 'Staged changes',
      worktree: 'Working tree changes',
    },
  },

  github: {
    title: 'GitHub',
    panel: {
      inbox: 'Waiting on you',
      repo: 'This repo',
      prs: 'Pull requests',
      issues: 'Issues',
      checks: 'Checks',
      noWorkdir: 'Point this chat at a folder to see its pull requests and issues.',
      open: 'Open the GitHub panel',
      back: 'Back to the list',
      branchChip: '#{number} · {status}',
    },

    /** One-line check summary, for the Repository panel's branch chip. */
    chip: {
      checksFailing: 'checks failing',
      checksRunning: 'checks running',
      checksPassing: 'checks passing',
      noChecks: 'no checks',
    },

    actions: {
      openInBrowser: 'Open in browser',
      copyUrl: 'Copy URL',
      copyReference: 'Copy owner/repo#123',
      copied: 'Copied to the clipboard.',
      pasteReference: 'Paste the reference into the message',
      reviewCommentsToComposer: 'Send review comments to the composer',
      issueToNewChat: 'Start a new chat from this issue',
      createPr: 'Create pull request',
      markReady: 'Mark ready for review',
      checkout: 'Check out this branch',
      refresh: 'Refresh',
      pushAndCreatePr: 'Push the branch and create the pull request',
    },
  },

  terminal: {
    title: 'Terminal',
    newSession: 'New terminal',
    closeSession: 'Close terminal',
    rename: 'Rename terminal',
    renameLabel: 'Terminal name',
    popOut: 'Open in a window',
    openInWindow: 'This terminal is open in another window.',
    takeOver: 'Bring it here',
    tabs: 'Terminal sessions',
    empty: 'No terminal is open for this chat',
    emptyHint: 'Open one to run commands in this environment.',
    reconnecting: 'Reconnecting…',
    disconnected: 'Disconnected from the terminal.',
    notFound: 'This terminal session no longer exists.',
    refused: 'This terminal session cannot be opened from here.',
    openFailed: 'Could not open a terminal. Try again.',
    closeFailed: 'Could not close the terminal. Try again.',
    exited: 'Process exited with code {code}.',
    exitedBySignal: 'Process ended by {signal}.',
    exitedConsentRevoked: 'Terminal closed because shell access was revoked.',
    dropped: '{bytes} bytes of output were dropped because the viewer could not keep up.',
    runtimeDisconnected: 'The runtime went away; this session ended.',
    closeConfirmTitle: 'Close this terminal?',
    closeConfirmDescription: 'The shell and anything it is running will be stopped.',
    cancel: 'Cancel',
    unavailableTitle: 'Terminal is unavailable',
    unavailableTitleLimit: 'Terminal limit reached',
    manageSessions: 'Manage terminals',
    unavailable: {
      disabled: 'Terminals are turned off on this hub.',
      limit: 'You already have the maximum number of open terminals.',
      notIsolated:
        'The Local runtime shares the hub’s account with other users, so terminals stay off there.',
      unavailable:
        'This environment cannot open a terminal. It needs a shell and the shell permission.',
      runtimeUpdateRequired:
        'This environment’s runtime needs an update before terminals can open safely.',
      runtimeUnavailable: 'The runtime could not open the terminal. Try again.',
      disconnected: 'The environment is not connected.',
    },
    page: {
      title: 'Terminal',
      openHere: 'Open here',
      hide: 'Hide',
      noSessions: 'No terminals are open for this environment',
    },
    commands: {
      openPanel: 'Open terminal panel',
      newSession: 'New terminal session',
    },
  },

  common: {
    loading: 'Loading…',
    appName: 'MangoStudio',
    downloadFilenamePrefix: 'mangostudio',
    mangoStudioLogo: 'MangoStudio logo',
    retry: 'Retry',
    noResultsFor: 'No results for “{query}”',
    contextIndicator: 'Context usage indicator',
    // Named by the sidebar, the account menu and the palette, which render before
    // the `settings` namespace is loaded.
    settings: 'Settings',
    settingsNavigation: 'Settings navigation',
    openMenu: 'Open menu',
    closeMenu: 'Close menu',
    accountMenu: 'Account menu',
    disclaimer: 'AI can make mistakes. Double-check the results.',
    dismissToast: 'Dismiss toast',
    notifications: 'Notifications',
  },

  library: {
    targets: {
      mangostudio: 'MangoStudio',
      claude: 'Claude Code',
      codex: 'Codex',
      cursor: 'Cursor',
    },
    kinds: {
      skill: 'Skill',
      subagent: 'Subagent',
      command: 'Command',
      instruction: 'Instruction',
      setting: 'Setting',
      hook: 'Hook',
    },
    // The same nouns inside a sentence ("Propagate skill gh"), where the label
    // above would put a capital in the middle of it.
    kindsInline: {
      skill: 'skill',
      subagent: 'subagent',
      command: 'command',
      instruction: 'instruction',
      setting: 'setting',
      hook: 'hook',
    },
    // What a matrix cell prints beside its glyph, and what the legend prints for
    // the glyphs where a cell is a glyph alone. The column is a fraction of the
    // table, so the sentence-length `cellState` would not fit; that one stays on
    // the accessible name, and `cellHint` is the sentence behind the tooltips.
    cellStateShort: {
      'scan-incomplete': 'Scan incomplete',
      present: 'Present',
      absent: 'Absent',
      shadowed: 'Shadowed',
      divergent: 'Differs',
      'only-here': 'Only here',
      incomparable: 'Cannot compare',
    },
    locationSettings: {
      description:
        'Only the directories switched on here are scanned. This applies to every machine; the state beside each one is what the selected machine reports.',
      /**
       * Shown instead of the switches until the hub has detected which agent
       * CLIs are installed: the enablement it would show is a placeholder.
       */
      detecting: 'Detecting installed agents…',
      scan: 'Scan',
      /** Accessible name: every row's switch reads "Scan" on screen. */
      scanLocation: 'Scan {location}',
      alwaysOn: 'Always scanned',
      alwaysOnHint: 'MangoStudio owns this directory and cannot be blind to it.',
      entries: '{count} entries',
      missing: 'does not exist yet',
      readOnly: 'read-only',
      unsupported: 'unavailable on this platform',
    },
    matrix: {
      resourceColumn: 'Resource',
      selectAll: 'Select every visible resource',
      selectRow: 'Select {resource}',
      // Every cell is announced in words: the glyph alone is not accessible.
      cellLabel: '{resource} on {target}: {state}',
      openDetail: 'Open {resource}',
      legend: 'Legend',
      empty: 'No resources of this kind were found.',
      emptyHint: 'The locations MangoStudio reads may be empty or disabled.',
      emptyFiltered: 'No resource matches these filters.',
      clearFilters: 'Clear filters',
      selectedCount: '{count} selected',
      clearSelection: 'Clear selection',
      propagate: 'Propagate',
      loadError: 'The library could not be loaded.',
      retry: 'Try again',
      locationGroup: 'In {location}',
      locationGroupOther: 'In other locations',
    },
    wizard: {
      title: 'Propagate {count} resources',
      titleOne: 'Propagate {kind} {resource}',
      cancel: 'Cancel',
      back: 'Back',
      continue: 'Continue',
      stepConflict: 'Resolve conflicts',
      stepDestinations: 'Choose destinations',
      stepReview: 'Review',
      stepResult: 'Result',
      previewError: 'The preview could not be built.',
      // Distinct from `previewError`: nothing failed, there was nothing to ask
      // about. Retrying would only reproduce the same empty answer.
      noDestinations: 'No enabled location can hold this resource.',
      noDestinationsHint:
        'Every location for this kind is either disabled in settings or unavailable on this platform.',
      // 009 rejects an apply bound to a stale read; re-previewing is the way out.
      stale: 'The library changed since this read. Preview again before applying.',
      restale: 'Preview again',
    },
  },

  environments: {
    nav: 'Environments',
    tabs: {
      overview: 'Overview',
      // Label only: the tab still lives at /environments/runtimes and every
      // runtime id on the wire is unchanged.
      runtimes: 'Toolchains',
      agents: 'Agents',
      health: 'Health',
      library: 'Library',
      machine: 'This machine',
    },
    // A binary that answered but whose version output did not parse. Applies to
    // runtimes and agent CLIs alike, which is why it lives here rather than
    // inside either section.
    versionUnknown: 'unknown version',
    machine: {
      service: {
        title: 'Service',
        description:
          'A per-user service starts MangoStudio at login and brings it back after a reboot, so it is there before you open the browser.',
        installed: 'Installed',
        notInstalled: 'Not installed',
        // The supervisor could not be asked, so neither of the two above is known.
        unknown: 'Could not check',
        supervisor: {
          linux: 'systemd user unit',
          darwin: 'launchd agent',
          win32: 'Scheduled task',
          unsupported: 'No supervisor on this platform',
        },
        enabledLabel: 'At login',
        enabled: 'Enabled',
        disabled: 'Disabled',
        runningLabel: 'State',
        running: 'Running',
        stopped: 'Stopped',
        // The card's state in one word opposite its title, so it never lacks a badge.
        stateOn: 'On',
        stateOff: 'Off',
        stateUnknown: 'Unknown',
        lingerLabel: 'After logout',
        lingerOn: 'Keeps running',
        lingerOff: 'Stops at logout',
        runs: 'Runs',
        errors: {
          'no-systemd': 'This machine has no systemd, so there is no per-user service to manage.',
          'no-session-bus':
            'The user session bus is not reachable from here, so systemd could not be asked. Open a desktop session on this machine, or enable linger for this user.',
        },
      },
      actions: {
        restart: 'Restart',
        installService: 'Install service',
        uninstallService: 'Remove service',
        confirm: 'Continue',
        cancel: 'Cancel',
        confirmRestartTitle: 'Restart MangoStudio?',
        confirmRestartDescription:
          'Every chat and connection drops for a few seconds while the server comes back. This is the same as running:',
        confirmInstallTitle: 'Install the service?',
        confirmInstallDescription:
          'MangoStudio will start at login from now on. The running server hands over to the service, which drops connections for a few seconds. This is the same as running:',
        confirmUninstallTitle: 'Remove the service?',
        confirmUninstallDescription:
          'MangoStudio will no longer start at login. If the service is what is running now, it stops with it. This is the same as running:',
        runInstead: 'Run this in a terminal instead',
        refused: 'The server refused this action.',
        failed: 'The action could not be sent.',
        accepted: {
          'restarting-service':
            'Restart requested through {unit}. The page reconnects when the server is back.',
          'restarting-detached':
            'Restarting in the background. The page reconnects when the server is back.',
          'service-installed-handover':
            'Installed {unit}. Handing over to it now; the page reconnects when it is up.',
          'service-installed': 'Installed {unit}.',
          'service-removing':
            'Removing {unit}. This server stops with it; start it again with "mangostudio serve -d".',
          'service-removed': 'The service was removed. This server keeps running.',
          /** Stands in for `{unit}` when the response names no unit. */
          unnamedUnit: 'the service',
        },
        guard: {
          container:
            'This hub runs inside a container; restart it and manage its service from the container host.',
          'server-not-loopback':
            'MangoStudio is reachable from other machines, so it will not restart itself or change its service from a browser.',
          'client-not-loopback': 'This page was not opened from the machine the hub runs on.',
        },
        reasons: {
          guard: 'This action is only available from a browser on the machine the hub runs on.',
          foreground:
            'The server was started in a terminal, which owns it. Press Ctrl-C there and start it again.',
          'windows-service':
            'A scheduled task cannot stop or restart itself from inside its own process. Use the command below.',
          'already-installed': 'The service is already installed.',
          'not-installed': 'There is no service to remove.',
          'unsupported-platform': 'No per-user service manager is supported on this platform.',
          'service-unreadable': 'The service manager could not be asked; see the error above.',
          'secret-not-persisted':
            'The auth secret lives only in this process\u2019s environment, so a service could not start with it. Run the command below once in a terminal; it stores the secret first.',
          'install-failed':
            'The service manager could not install the unit here. Run the command below in a terminal instead.',
          'uninstall-failed':
            'The service manager could not remove the unit here. Run the command below in a terminal instead.',
        },
      },
      update: {
        title: 'Update',
        available: 'MangoStudio {latest} is available (you run {current})',
        upgrade: 'Upgrade',
        dismiss: 'Dismiss',
        dismissAria: 'Dismiss the update notice',
        details: 'Details',
        installedVia: 'Installed via',
        channel: 'Channel',
        channelName: {
          stable: 'Stable',
          canary: 'Canary',
        },
        latest: 'Latest',
        upToDate: 'Up to date ({version})',
        checksDisabled: 'Checks disabled',
        notCheckedYet: 'Not checked yet',
        checkFailed: 'Check failed',
        updateAvailable: '{version} available',
        manager: {
          'self-managed': 'Install script',
          npm: 'npm',
          bun: 'npm (bun global)',
          pnpm: 'npm (pnpm global)',
          homebrew: 'Homebrew',
          scoop: 'Scoop',
          cargo: 'Cargo',
          docker: 'Docker image',
          source: 'Source checkout',
          unknown: 'Unknown',
        },
        refusalReasons: {
          'source-checkout':
            'This build runs from a source checkout. Rebuild it instead of upgrading it here.',
          container: 'This hub runs inside a container. Pull the new image tag instead.',
          'package-manager':
            'A package manager owns this install. Run the command below to update it.',
          'channel-unsupported':
            'The package manager that owns this install has no build on this channel.',
          'unknown-origin':
            'MangoStudio could not tell how this build was installed, so it will not try to replace it.',
          'unsupported-target':
            'There is no published build for this platform on this channel yet.',
          'windows-service':
            'A scheduled task cannot replace its own binary from inside its own process. Use the command below.',
          'in-progress': 'Another upgrade is already running from this hub.',
        },
        dialog: {
          title: 'Upgrade to {latest}?',
          description:
            'The server restarts when the new version is in place; open terminals end with it.',
          latestUnknown: 'the latest version',
        },
        stage: {
          resolve: 'Resolving the release…',
          download: 'Downloading…',
          verify: 'Verifying…',
          install: 'Installing…',
          restart: 'Restarting…',
        },
        outcome: {
          upgraded: 'Upgraded to {version}.',
          alreadyCurrent: 'Already running the latest version.',
          failedGeneric: 'The upgrade failed for an unknown reason.',
          /**
           * What the report's `restart` says happened after the pointer moved.
           * Installing is not activating: without this line an upgrade that
           * needs a hand-run restart reads as finished while the old process
           * keeps serving.
           */
          restart: {
            scheduled: 'The server is restarting with the new version.',
            'not-running': 'It starts the next time you run the server.',
            skipped: 'The server is still running the old version; restart it to use the new one.',
            manual:
              'The server is still running the old version and cannot restart itself — restart it to finish.',
          },
        },
        streamEnded: 'The connection ended before the upgrade finished.',
        streamFrameTooLong: 'The upgrade output has a line too long to show, so it was stopped.',
      },
    },
    // Product names — identical in every locale, but centralized here so the UI
    // never renders a raw id such as `nvm` or `mangostudio`.
    names: {
      bun: 'Bun',
      node: 'Node.js',
      nvm: 'nvm',
      fnm: 'fnm',
      winget: 'winget',
      git: 'Git',
      volta: 'Volta',
      mangostudio: 'MangoStudio',
      claude: 'Claude Code',
      codex: 'Codex',
      cursor: 'Cursor',
    },
    status: {
      ok: 'Available',
      warn: 'Needs attention',
      missing: 'Not found',
      error: 'Probe failed',
    },
    actions: {
      refresh: 'Re-check',
      refreshFailed: 'Re-check failed. The details below may be out of date.',
      retry: 'Try again',
      copy: 'Copy command',
      copied: 'Command copied',
      copyFailed: 'The command could not be copied.',
    },
    entities: {
      disabled: 'Disabled',
      status: {
        connected: 'Connected',
        connecting: 'Connecting',
        disconnected: 'Disconnected',
        error: 'Connection failed',
        updating: 'Updating',
        pulling: 'Pulling image',
        boundElsewhere: 'Bound elsewhere',
      },
      transport: {
        'in-process': 'Hub-launched',
        stdio: 'Local process',
        wsl: 'WSL',
        websocket: 'WebSocket',
        http: 'Direct URL',
        ssh: 'SSH',
        container: 'Container',
      },
      // The toolchain summary line: what this machine's shell resolves for
      // Node and Bun, at a glance.
      toolchainSummaryNode: 'Node {version} ({source})',
      toolchainSummaryBun: 'Bun {version}',
      toolchainSummaryMissing: '{runtime} not installed',
    },
    runtimes: {
      description: 'Once two binaries share a name, only one runs. Here is which one.',
      effectiveLabel: 'Effective',
      pathIndexLabel: 'PATH #{position}',
      managedByLabel: 'managed by {manager}',
      versionCount: '{count} versions',
      singleVersion: '1 version',
      aliasReachable: 'reachable via {count} paths',
      otherInstallations: 'Other installations',
      noEffective: 'No usable binary was found.',
      notInstalled: '{runtime} is not installed yet.',
      install: 'Install {runtime}',
      update: 'Update {runtime}',
      uninstall: 'Uninstall {runtime}',
      empty: 'No runtimes were detected on this machine.',
      emptyHint: 'MangoStudio can set up whatever is missing for you.',
      // For a manager MangoStudio can name: Volta, Bun, itself.
      managedElsewhere: 'Managed by {manager}, not by MangoStudio.',
      // For a plain system install, which has no name to plug into the
      // template above ("Managed by the system" reads fine in English, but
      // the equivalent does not hold in every locale — this is its own
      // sentence rather than a {manager} value).
      managedBySystem: 'A system install, not managed by MangoStudio.',
      nodeVersionManager: 'Node version manager',
      prerequisiteHint:
        'A Windows package manager MangoStudio uses to run other install recipes, not something it installs itself.',
      useThisVersion: 'Use this version',
      selected: 'Selected',
      backToAutomatic: 'Back to automatic',
      toolchainAuto: 'Processes run the automatic choice: {version} from {source}.',
      // For a plain system install, which has no name to plug into the
      // template above — same reasoning as `managedBySystem`.
      toolchainAutoSystem: 'Processes run the automatic choice: {version}, a system install.',
      toolchainPinned: 'Processes run {version} from {path}.',
      toolchainUpdateFailed: 'The toolchain selection could not be updated.',
    },
    // Where an installation's binary was found to come from, appended to the
    // effective-installation line. Every `PathSource` literal has an entry.
    pathSources: {
      system: 'system install',
      nvm: 'from nvm',
      fnm: 'from fnm',
      volta: 'from Volta',
      winget: 'from winget',
      bun: "from Bun's installer",
      'mangostudio-managed': 'managed by MangoStudio',
    },
    lts: {
      'current-lts': 'current LTS',
      'lts-outdated-patch': 'outdated LTS patch',
      'lts-superseded': 'superseded LTS',
      'end-of-life': 'end of life',
      'current-release': 'current release',
      unknown: 'LTS status unavailable',
    },
    // One key per finding code: the translation is where the consequence
    // sentence lives, so it cannot be skipped.
    findings: {
      'not-found': '{runtime} was not found on PATH or in any well-known location.',
      'installed-but-not-on-path':
        '{runtime} is installed at {path} but not on PATH, so your shell cannot run it.',
      'shadowed-by-earlier-path':
        'Typing the command runs {shadowedPath} (PATH #{shadowedPathIndex}), not {effectivePath} (PATH #{effectivePathIndex}).',
      'multiple-versions':
        'More than one {runtime} is installed ({versions}); only the first one on PATH runs.',
      'version-below-minimum':
        '{path} reports {version}, so features that need {minimumVersion} or newer will fail.',
      'version-below-minimum-for': '{version} is below the {minimumVersion} that {consumer} needs.',
      'not-executable': '{path} exists but did not answer a version query.',
      'outdated-lts': 'Version {version} is {ltsStatus} and will stop receiving fixes.',
      'managed-but-not-on-path':
        'The {manager} alias {defaultAlias} is not on PATH, so its Node does not run in new shells.',
      'probe-timeout': 'Probing {path} timed out, so its result is unknown.',
      'cli-not-installed': 'The {targetId} CLI is not installed, so MangoStudio cannot invoke it.',
      'config-home-missing':
        '{configHome} does not exist, so there is no configuration to read or write yet.',
      'not-authenticated': '{targetId} is not signed in, so its calls will be rejected.',
      'version-probe-failed':
        '{path} reported a version that was not recognized, so compatibility checks are skipped.',
      'location-unwritable':
        '{path} is not writable, so MangoStudio cannot publish resources to {locationId}.',
      'prerequisite-missing':
        '{recipe} needs {requirement}, which is not installed on this machine. {remedy}',
    },
    agents: {
      description: 'Each agent CLI, the configuration it reads, and where the Library can write.',
      versionLabel: 'Version',
      configHomeLabel: 'Configuration',
      authSignedIn: 'Signed in',
      authSignedOut: 'Not signed in',
      authUnknown: 'Sign-in state unknown',
      authUnknownHint: 'A file-presence probe cannot see a system keychain.',
      locations: 'Library locations',
      locationWritable: 'writable',
      locationReadOnly: 'read-only',
      locationMissing: 'does not exist yet',
      locationUnsupported: 'unavailable on this platform',
      locationEntries: '{count} entries',
      notInstalled: 'Not installed',
      empty: 'No agent CLIs were detected.',
      emptyHint: 'MangoStudio can install an agent CLI for you on this machine.',
    },
    install: {
      confirmTitle: 'Run this install?',
      confirmDescription: 'This runs a command on this machine. Review it before continuing.',
      confirmUninstallTitle: 'Remove {target}?',
      confirmUninstallDescription:
        'This removes {paths} from this machine. Review it before continuing.',
      runUninstall: 'Remove',
      // Shown instead of a run button when a recipe has no vendor-documented
      // unattended shape — the copyable command is the whole offer.
      unrunnable: {
        'vendor-undocumented':
          'The vendor does not document this step, so MangoStudio only shows the command.',
      },
      commandLabel: 'Command',
      willWrite: 'Writes to',
      requiresNetwork: 'Requires network access',
      downloadLabel: 'Downloaded installer',
      downloadOrigin: 'Installer downloaded from {url}',
      downloadSize: '{size} received',
      profileSetup: 'Add to your shell profile once the install finishes:',
      profileAlreadyPresent: 'Already present in {files}',
      run: 'Run install',
      cancel: 'Cancel',
      close: 'Close',
      cancelRun: 'Cancel install',
      consoleTitle: 'Install console',
      autoscroll: 'Autoscroll',
      waitingForOutput: 'Waiting for output…',
      exitSummary: 'Exited with code {code} after {duration}',
      exitSummaryNoCode: 'Exited after {duration}',
      truncated: 'The output was truncated by the server.',
      linesDropped: '{count} earlier lines were dropped.',
      startError: 'The install could not be started.',
      streamError: 'The install console connection dropped.',
      streamFrameTooLong: 'The install output has a line too long to show, so it was stopped.',
      reconnecting: 'Reconnecting to the console…',
      unsupported: 'This install is not supported on this platform.',
      missingRequirements: 'Install first: {requirements}',
      chainLabel: 'Install {prerequisites}, then {target}',
      chainDescription:
        'This runs {count} commands on this machine, in order. Review them before continuing.',
      chainStep: 'Step {index} of {count} · {name}',
      chainStopped: '{target} was not installed: {prerequisite} did not finish.',
      requirementUnavailable:
        '{target} needs {requirements}, and MangoStudio cannot install {requirements} on this machine. Install it yourself, then re-check.',
      runStatus: {
        running: 'Installing…',
        succeeded: 'Install finished',
        failed: 'The install failed',
        cancelled: 'Install cancelled',
        'timed-out': 'The install timed out',
        'spawn-failed': 'The install could not be started',
        interrupted: 'The server stopped mid-install, so the outcome is unknown',
      },
      guardBlockedTitle: 'Automatic install unavailable',
      copyCommandHint: 'Run this command in a terminal on this machine:',
      guardBlocked: {
        container:
          'Installs are disabled inside a container: the change would vanish on the next image build.',
        'server-not-loopback':
          'Installs are disabled while MangoStudio is reachable from other machines.',
        'client-not-loopback':
          'This request did not come from this machine, so it cannot install anything here.',
        'client-unverified':
          'MangoStudio trusts a reverse proxy, and this request carried no forwarded address, so where it came from could not be established. That refusal is what security.allowDirectLoopback = false asks for; the proxy in front of this hub has to set X-Forwarded-For.',
        disabled: 'Installs are disabled in this server configuration.',
        'environment-not-trusted':
          'This environment has not been trusted with installs. Turn it on for that machine, on its card in Environments.',
        'runtime-denied':
          'That machine refuses shell, which every install needs. Run mangostudio-runtime setup there and grant shell, or install by hand.',
      },
      enableInstalls: {
        button: 'Enable installs on this machine',
        title: 'Enable installs on this machine?',
        description:
          'MangoStudio will accept guarded install and update commands sent from a browser on this machine.',
        threatModel:
          'Enable this only for a MangoStudio process running on the same machine as its user. The setting does not override the local-surface checks that still apply.',
        confirm: 'Enable',
        success: 'Installs are enabled on this machine now. Try again.',
        envOverride:
          'An environment variable still overrides this setting, so installs stay off. Unset MANGO_ENV_INSTALLS_ENABLED, or set it to true, then try again.',
        failed: 'The setting could not be saved.',
      },
    },
  },

  externalAgents: {
    target: {
      codex: 'Codex CLI',
      cursor: 'Cursor CLI',
      claude: 'Claude Code',
    },
    selector: {
      label: 'Who runs this chat',
      mangostudioGroup: 'MangoStudio',
      externalGroup: 'External agents',
      loading: 'Loading agents…',
      noneDiscovered: 'No external agents found on this machine.',
      signedIn: 'signed in',
      authUnknown: 'sign-in state unknown',
      discoveryUndetermined: 'availability undetermined',
      discoveryUndeterminedHint:
        'The probe could not confirm this agent or its version. You can still try a turn.',
      notInstalledIn: 'Not installed in {environment}',
      /** Stands in for a required version a runtime reported without naming. */
      unknownVersion: 'a newer version',
      continueInNewChat: 'Continue in a new chat',
      copyLoginCommand: 'Copy login command',
      signInHint: 'Run this in a terminal, then retry.',
      ownership: '{vendor} controls its own tools and permissions.',
      unavailableHere: 'This agent cannot run here right now.',
      /** The next step under `unavailableHere`, and under a reason with nothing to click. */
      unavailableTryElsewhere: 'Pick another runner in the header, or try again in a moment.',
      forkFailed: 'The new chat could not be created.',
    },
    /** Why a send could not open, when the answer is not about the agent itself. */
    openFailure: {
      capacity:
        'The maximum number of external agent sessions is in use. Close one, or try again in a moment.',
    },
    sessions: {
      /** The selector entry that opens the picker. */
      entry: 'Continue a session from your terminal',
      title: 'Continue a session from your terminal',
      subtitle:
        'Pick a session you started with a CLI on {environment}. MangoStudio continues it — it does not copy its history.',
      loading: 'Looking for sessions…',
      empty: 'No sessions found on this machine.',
      emptyInWorkspace: 'No sessions for this folder. Turn off the filter to see the rest.',
      thisWorkspaceOnly: 'Only this folder',
      loadMore: 'Show more',
      noTitle: 'Untitled session',
      adopt: 'Continue',
      adopting: 'Opening…',
      // Ages are relative and deliberately coarse: the exact second a vendor
      // last touched a thread is noise next to "this morning" or "last week".
      ageJustNow: 'just now',
      ageMinutes: '{count}m ago',
      ageHours: '{count}h ago',
      ageDays: '{count}d ago',
      loadFailed: 'Could not load sessions from this machine.',
      /** Every adoption refusal the server can answer with. */
      adoptFailed: 'That session could not be continued.',
      staleSession:
        'That session changed since the list loaded. It has been refreshed — pick again.',
      heldSession: 'That session is already open in another MangoStudio chat.',
      unreachable: 'Could not reach the machine those sessions live on.',
      isolationUnproven:
        'This machine has not proved it keeps vendor logins separate, so its sessions are not listed.',
      /**
       * Claude's row. It says why rather than implying something is broken:
       * the CLI keeps its history in an internal JSONL format the vendor
       * documents as internal and subject to change, so there is no listing to
       * read that would still be right next month.
       */
      unsupported: 'This agent does not publish a list of its own sessions.',
      unsupportedClaude:
        'Claude Code keeps its history in an internal format its own documentation says may change, so MangoStudio does not read it. Start a Claude chat here instead.',
    },
    usage: {
      turnLabel: 'This turn',
      threadLabel: 'This chat',
      input: 'in',
      output: 'out',
      total: 'total',
      /** Names the ring on the composer strip; the breakdown lives in its tooltip. */
      indicatorLabel: 'Token usage',
      contextLabel: 'Context',
      contextValue: '{used}/{limit} · {percent}%',
      contextUnknown: 'Context window unknown',
    },
    limits: {
      remaining: '{percent}% left',
      resetsIn: 'resets in {duration}',
      resetsAt: 'resets {time}',
      // Compact units for the `{duration}` above. They live in the catalogue
      // because a suffix is user-visible text like any other: 'm' is not the
      // minute abbreviation everywhere, and neither is the hours-minutes order.
      durationMinutes: '{count}m',
      durationHours: '{count}h',
      durationHoursMinutes: '{hours}h {minutes}m',
      durationDays: '{count}d',
      unknown: 'Quota unknown',
      stale: 'Quota outdated',
      exhausted: 'Quota exhausted',
      refresh: 'Refresh quota',
      refreshFailed: 'Could not refresh quota.',
    },
    model: {
      label: 'Agent model',
      effortLabel: 'Reasoning effort',
      vendorDefault: "The vendor's default",
    },
    disclosure: {
      title: 'Before you use {vendor}',
      thirdParty:
        '{vendor} is a third-party product with its own terms, running on the machine you chose.',
      dataFlow:
        'What you send in this chat goes to {vendor}, which decides what to do with it and where to send it.',
      billing: 'Usage is billed to your {vendor} account, not to MangoStudio.',
      ownership:
        "{vendor} uses its own tools, permissions and sandbox. MangoStudio's tool settings do not apply here.",
      autoExecution:
        'Depending on the level you choose, {vendor} can edit files and run commands without asking again.',
      accept: 'Got it, continue',
      accepting: 'Saving…',
      acceptFailed: 'Your acknowledgement could not be saved, so the agent was not enabled.',
      cancel: 'Cancel',
      close: 'Close',
      review: 'Review the notice',
      // Claude-specific, and rendered only for Claude. Codex and Cursor read
      // project files too, but nobody has written down what each of them loads,
      // and a disclosure that names the wrong sources for a vendor is worse than
      // one that stays quiet about it.
      inheritedConfigurationClaude:
        'Claude Code also loads the hooks, skills, plugins, MCP servers, auto memory and CLAUDE.md configured on that machine outside MangoStudio, and runs them as part of your turn.',
      permissionNow: 'Right now this chat is set to: {level}.',
      terms: "{vendor}'s terms of service",
      privacy: "{vendor}'s privacy policy",
      required: 'This agent needs its notice acknowledged before it can run.',
      manageDescription:
        'A third-party agent CLI shows a notice before it first receives a conversation. The ones you accepted are listed here.',
      manageEmpty: 'No external agents acknowledged yet',
      manageEmptyHint:
        'A notice is recorded the first time you run Claude Code, Codex or Cursor from MangoStudio.',
      acknowledgedAt: 'Acknowledged {date}',
      revoke: 'Withdraw',
      revoking: 'Withdrawing…',
      revokeFailed: 'Your acknowledgement could not be withdrawn.',
      revokeHint: 'Withdrawing stops any turn running now and asks again next time.',
    },
    unavailable: {
      'not-installed': 'Not installed on this machine',
      'signed-out': 'Installed, but signed out',
      'runtime-unsupported': 'This machine runs a version that cannot host it',
      'runtime-denied': "This machine's owner has not allowed external agents",
      'environment-unreachable': 'Could not reach this machine',
      'isolation-unproven': 'This machine has not proven it keeps credentials separate',
      // The only unavailable reason that names a fix precisely, because it is
      // the only one where the fix is a single command the user can run.
      // `{version}` is filled from the descriptor's `requiredVersion`.
      'version-unsupported': 'Update this agent to {version} or later on this machine',
      'disclosure-required': 'Read and accept this agent\u2019s third-party notice first',
      'installed-but-unusable':
        'Installed and signed in, but it accepts none of the permissions MangoStudio offers',
      // The sentence carries the next step: the remedy for this reason offers no control.
      'launch-refused':
        'Installed, but the operating system refused to start it. Check that the file is executable or reinstall it, then try again.',
    },
    /** The next step, not just the diagnosis. */
    remedy: {
      install: 'Install this agent',
      update: 'Update this agent',
      'sign-in': 'Sign in to this agent',
      'contact-admin': 'Ask whoever administers this machine',
      'accept-disclosure': 'Read the notice',
      none: 'There is nothing to do from here',
    },
    isolation: {
      title: 'This machine cannot keep vendor logins separate',
      why: 'MangoStudio can only run an external agent where the vendor account it signs in with is provably yours.',
      nextStep: 'What fixes it',
      next: {
        local: 'Run this hub for a single MangoStudio user, or give each user their own machine.',
        wsl: 'Give each MangoStudio user their own WSL user account inside the distribution.',
        ssh: 'Give each MangoStudio user their own account on the remote host, instead of one shared login.',
        container:
          'Give each MangoStudio user their own container, and remove any mount that exposes the host\u2019s agent credentials into it.',
        paired:
          'A paired machine belongs to the person who paired it. Pair your own, or use an environment you own.',
        generic: 'Give each MangoStudio user their own operating-system account on that machine.',
      },
    },
    permission: {
      label: 'Permissions',
      /** The key half of the composer's `mode: read-only` chip. */
      modeKey: 'mode',
      whatItCanDo: 'What it can do',
      whoApproves: 'Who approves',
      unattendedLevelWarning: 'This agent can edit and run anything.',
      unattendedRoutingWarning: 'Approvals are answered without you.',
      unsupportedGeneric: 'This agent does not offer this combination',
      levelName: {
        'read-only': 'Read only',
        default: 'Default',
        'full-access': 'Allow everything',
      },
      routingName: {
        user: 'You',
        'auto-review': 'Auto-review',
      },
      level: {
        'read-only': 'Read only — it can look at the workspace but not change it.',
        default: 'Default — it can change the workspace and asks before anything riskier.',
        'full-access': 'Full access — it can act without asking, including outside the workspace.',
      },
      routing: {
        user: 'You answer each request.',
        'auto-review': 'The agent reviews its own requests.',
      },
      /** Named choices, for people who should not have to learn the matrix. */
      advanced: 'Fine-tune',
      presetHeading: 'Mode',
      preset: {
        careful: {
          label: 'Careful',
          description: 'Reads only. Nothing changes unless you ask again.',
        },
        balanced: {
          label: 'Balanced',
          description: 'Changes the workspace and asks before anything riskier.',
        },
        autonomous: {
          label: 'Autonomous',
          description: 'Keeps going on its own.',
        },
      },
      /** What each preset means for this vendor specifically. */
      presetVendor: {
        careful: {
          claude: 'Claude enters plan mode and refuses changes.',
          codex: 'Codex runs in a read-only sandbox.',
          cursor: 'Cursor stays in plan mode.',
        },
        balanced: {
          claude: 'Claude asks permission for every change outside what was agreed.',
          codex: 'Codex writes in the workspace and asks permission for the rest.',
          cursor: 'Cursor writes in the workspace and asks before the rest.',
        },
        autonomous: {
          claude: 'Claude acts without asking, including outside the workspace.',
          codex: 'Codex acts without asking, including outside the sandbox.',
          cursor: 'Cursor acts without asking, including outside the workspace.',
        },
      },
    },
    workspaceTrust: {
      title: 'Let this agent read this folder\u2019s own setup?',
      rules:
        'It loads the rules and project configuration committed in this folder, and follows them.',
      mcp: 'It starts the MCP servers this folder defines, with the access those servers have.',
      // Names the real breadth of the grant: the key is the user, the machine
      // and the folder, which means every chat pointed at this folder, not just
      // this one. Settings > External agents lists it and can withdraw it.
      scope:
        'This applies to this folder on this machine, in every chat that uses it, until you withdraw it under Settings > External agents.',
      warning:
        'Whoever wrote this repository wrote those instructions. Only continue if you trust it.',
      accept: 'Trust this folder',
      saving: 'Saving\u2026',
      cancel: 'Not now',
      saveFailed: 'Your choice could not be saved, so nothing was sent.',
      manageTitle: 'Trusted folders',
      manageDescription:
        'Folders where you let an agent load the repository’s own rules and MCP servers.',
      manageEmpty: 'No trusted folders yet',
      manageEmptyHint:
        'A folder is recorded when you choose to trust it before an agent first runs there.',
      manageHint:
        'Withdrawing covers every chat that uses the folder. A turn already running keeps going; the next message asks again.',
      grantedAt: '{vendor} · {environment} · Trusted {date}',
      revoke: 'Withdraw',
      revoking: 'Withdrawing…',
      revokeFailed: 'Your trust in this folder could not be withdrawn.',
    },
    unsupported: {
      codexProfileDisallowed: "This machine's Codex configuration does not allow that profile",
      codexVersionTooOld: 'The Codex CLI on this machine is too old — upgrade it to use it here',
      cursorVersionTooOld: 'The Cursor CLI on this machine is too old — upgrade it to use it here',
      cursorAcpUnavailable:
        "This machine's Cursor CLI did not answer the protocol MangoStudio speaks",
      cursorModeMissing: 'This Cursor account does not offer the mode this level needs',
      cursorNoFullAccess:
        'Cursor does not expose this over its protocol — set it in the Cursor CLI itself',
      cursorNoAutoReview: 'Cursor answers approvals itself only when its own configuration says so',
      claudeVersionTooOld:
        'The Claude Code CLI on this machine is too old — upgrade it to use it here',
      claudeModeMissing: "This machine's Claude Code does not offer the mode this level needs",
      claudeAutoNeedsSubscription:
        'Auto-review needs a Claude subscription plan; this machine signs in another way',
      claudeAutoDisabledByPolicy: 'Your organization has turned auto mode off for Claude Code',
      claudeAutoUnverified: 'MangoStudio could not confirm this Claude account allows auto mode',
      claudeReadOnlyHasNoReviewer:
        'Claude Code has nothing to review in read-only mode — it never acts',
      claudeFullAccessHasNoReviewer:
        'Claude Code reviews nothing once everything is allowed without asking',
    },
    approval: {
      title: 'The agent is asking for permission',
      answered: 'Permission answered',
      expired: 'Permission expired',
      cancelled: 'Permission cancelled',
      expiredHint: 'The turn ended before anyone answered, so this request is dead.',
      cancelledHint: 'The turn was cancelled before anyone answered.',
      autoReviewedHint: "Answered by the agent's own auto-reviewer, without you.",
      truncatedHint: 'The agent sent more text than fits here; it was cut.',
      submitError: 'Your answer could not be sent.',
      option: {
        accept: 'Allow once',
        acceptForSession: 'Allow for the rest of this session',
        decline: 'Decline',
        cancel: 'Cancel',
        grantTurn: 'Grant for this turn',
        grantSession: 'Grant for the rest of this session',
        deny: 'Deny',
      },
    },
    activity: {
      attribution: 'Run by {agent}.',
      statusRunning: 'Running.',
      statusCompleted: 'Done.',
      statusFailed: 'Failed.',
      statusCancelled: 'Cancelled.',
      truncatedHint: 'The agent sent more text than fits here; it was cut.',
    },
    turn: {
      usageInput: 'in',
      usageOutput: 'out',
      usageReasoning: 'reasoning',
      usageCacheRead: 'cache read',
      usageCacheWrite: 'cache write',
      usageTotal: 'total',
      incomplete: 'Cut off.',
      // Shown when the chat had an earlier conversation and the agent did not continue it.
      conversationReset: {
        nonresumable:
          'The agent would not continue the earlier conversation, so this reply started a new one without the earlier messages.',
        unavailable:
          'The agent could not find the earlier conversation, so this reply started a new one without the earlier messages.',
      },
      terminal: {
        completed: 'Finished.',
        'cancelled-by-user': 'You stopped this turn.',
        interrupted: 'The agent stopped this turn.',
        'vendor-error': 'The agent reported a failure.',
        'runtime-disconnected': 'The connection to that machine dropped mid-turn.',
        'hub-restarted': 'MangoStudio restarted while this turn was running.',
        'acceptance-unknown':
          'MangoStudio could not confirm whether the agent received this turn. Send again to retry.',
        'sequence-gap': "Part of the agent's stream was lost, so this record is incomplete.",
        'limit-exceeded': 'This turn passed its size budget and was stopped.',
        'consent-revoked': "The machine's owner withdrew permission for external agents.",
        'session-lost': "That machine no longer has this turn's session.",
      },
    },
    // Labels for a vendor's own notice. The notice text is the vendor's and is not translated;
    // only the severity word, which is the product's, is.
    notice: {
      info: 'Notice',
      warning: 'Warning',
      error: 'Problem reported',
    },
    steer: {
      button: 'Steer',
      buttonHint: 'Send this into the running turn instead of waiting for it to finish.',
      sentLabel: 'You, mid-turn',
      rejectedLabel: 'This wasn’t delivered',
      // The hub could not tell whether the agent got it (timeout, a dropped
      // connection). Resending blindly could deliver it twice, so the copy sends
      // the person to the agent's reply first.
      deliveryUnknownLabel: 'Delivery not confirmed',
      deliveryUnknownHint:
        'The agent may or may not have received this. Check its reply before sending it again.',
      submitError: 'This could not be sent.',
      reason: {
        'turn-already-completed': 'The turn had already finished.',
        'not-supported': 'This agent cannot be steered.',
        'session-lost': "That machine no longer has this turn's session.",
        'turn-not-steerable': 'This turn cannot take new input right now.',
        'id-reused': 'This was already sent with different text. Try again.',
      },
    },
    /**
     * The agent's own review of the working tree.
     *
     * Every string here names its subject explicitly, because the permissions
     * dropdown has an "Auto-review" option and the two words mean opposite
     * things: this reviews *your* code, that one answers *the agent's* requests
     * for you. Someone who thought they had turned on code review and had
     * actually turned on unattended approvals would have been badly misled, so
     * the copy says which one it is rather than relying on placement.
     */
    review: {
      button: 'Review my changes',
      hint: '{vendor} reviews the code in your working tree — staged, unstaged and untracked.',
      /** What the transcript records the user as having asked for. */
      userMessage: 'Review my uncommitted changes.',
      running: 'Reviewing…',
      noChanges: 'Nothing to review — this folder has no uncommitted changes.',
      requiresGit: 'This folder is not a Git repository, so there are no changes to review.',
      requiresWorkdir: 'Choose a folder for this chat before asking for a review.',
      unsupported: 'This agent does not review your working tree.',
      failed: 'The review could not be started.',
    },
  },

  providers: {
    gemini: 'Google Gemini',
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    'openai-compatible': 'OpenAI-compatible',
    deepseek: 'DeepSeek',
    cursor: 'Cursor',
    chatgpt: 'ChatGPT',
    openrouter: 'OpenRouter',
  },

  thinking: {
    streaming: 'Thinking…',
    thought: 'Thought',
    withheld: 'Thought, reasoning not shared',
    toggle: 'View reasoning',
    enable: 'Reasoning',
    enabled: 'Reasoning enabled',
    disabled: 'Reasoning disabled',
    effort: 'Effort',
    effortLow: 'Low',
    effortMedium: 'Medium',
    effortHigh: 'High',
    effortXHigh: 'Extra high',
    effortMax: 'Maximum',
    reasoningBadge: 'Reasoning',
  },

  tools: {
    calling: 'Calling…',
    running: 'Running tool',
    done: 'Done',
    error: 'Tool error',
    moreCount: '+{count} more',
    argsLabel: 'args',
    errorLabel: 'error',
    resultLabel: 'result',
    stdoutLabel: 'stdout',
    stderrLabel: 'stderr',
    copyResult: 'Copy result',
    copyStream: 'Copy {stream}',
    resultCopied: 'Result copied',
    outputTruncated: 'The command printed more than fits here; the output was cut.',
    status: {
      queued: 'Queued',
      running: 'Running',
      awaiting_user: 'Waiting for you',
      succeeded: 'Done',
      failed: 'Failed',
      cancelled: 'Cancelled',
      timed_out: 'Timed out',
    },
    sources: {
      builtin: 'Built-in',
      skill: 'Skill',
      mcp: 'MCP',
      subagent: 'Subagent',
    },
    /** Why a failed, cancelled or timed-out call ended, one entry per `ToolExecutionReasonCode`. */
    reasons: {
      timeout: 'Time limit reached',
      user_cancelled: 'Cancelled by you',
      turn_aborted: 'Turn stopped',
      not_allowed: 'Not allowed',
      tool_disabled: 'Tool disabled',
      unknown_tool: 'Unknown tool',
      validation_failed: 'Invalid arguments',
      server_closed: 'Server closed',
      execution_error: 'Execution error',
      outcome_unknown: 'Outcome unknown',
    },
    /** A running call's clock beside its configured time limit, e.g. `12s of 30s`. */
    elapsedOfLimit: '{elapsed} of {limit}',
    /** The time limit a timed-out call was held to, e.g. `30s limit`. */
    timeLimit: '{limit} limit',
    /** What a finished call produced, shown right-aligned on the timeline row. */
    summary: {
      item: '{count} item',
      items: '{count} items',
      file: '{count} file',
      files: '{count} files',
      line: '{count} line',
      lines: '{count} lines',
      hit: '{count} hit',
      hits: '{count} hits',
      replacement: '{count} replacement',
      replacements: '{count} replacements',
      call: '{count} call',
      calls: '{count} calls',
      exitCode: 'exit {code}',
    },
    diff: {
      opCreate: 'New',
      opOverwrite: 'Overwritten',
      opUpdate: 'Edited',
      opDelete: 'Deleted',
      opMove: 'Moved',
      appliedCount: 'Applied to {count} occurrences',
      previousContentHidden: 'Previous content not shown',
      truncated: '+{count} hidden lines — open the raw result',
      showRaw: 'View raw',
      hideRaw: 'View diff',
    },
    labels: {
      list_directory: 'List',
      read_file: 'Read',
      write_file: 'Write',
      edit_file: 'Edit',
      replace_range: 'Replace range',
      apply_patch: 'Patch',
      create_file: 'Create',
      delete_file: 'Delete',
      move_file: 'Move',
      glob: 'Glob',
      grep: 'Grep',
      generate_image: 'Generate image',
      get_current_datetime: 'Date',
      bash: 'Bash',
      zsh: 'Zsh',
      powershell: 'PowerShell',
    },
    errors: {
      lineNumbersUnobserved:
        'Line numbers for "{path}" were never observed: the last read was a byte view (hex or base64), which does not assign line numbers. Re-read the file as text with read_file first, then retry replacing this range.',
    },
    retry: {
      action: 'Retry',
      retrying: 'Retrying…',
      confirmTitle: 'Run {tool} again?',
      confirmDescription:
        'The call runs again with the same arguments and may change what the first run already changed.',
      confirmDescriptionOutcomeUnknown:
        'The first run may have taken effect before it stopped. Running it again can repeat that.',
      argumentsLabel: 'Arguments',
      noArguments: 'No arguments',
      confirmAction: 'Run again',
      cancel: 'Cancel',
      failed: 'Could not retry the tool call.',
      byYou: 'Re-run by you',
    },
  },

  errors: {
    unknown: 'An unknown error occurred',
    referenceImageUploadFailed: 'Failed to upload reference image. Please try again.',
    textGenerationFailed: 'Failed to get a response. Please try again.',
    imageGenerationFailed: 'Failed to generate image. Please try again.',
    imageGenerationInterrupted: 'The turn was interrupted before this image was generated.',
    // Autosave can fail from any page that toggles a setting, so these stay out of the
    // deferred `settings` namespace.
    settingsSaveFailed: 'Could not save settings.',
    settingsSaveReverted: 'Could not save settings. Your last change was reverted.',
    notFound: {
      title: 'Page not found',
      hint: 'The link may be wrong, or the page may have moved.',
      home: 'Back to MangoStudio',
    },
    lazyChunk: {
      title: 'This view could not be loaded',
      hint: 'The connection may have dropped, or MangoStudio was updated while this tab was open. Try again, or reload the page.',
      reload: 'Reload page',
      staleTitle: 'MangoStudio was updated',
      staleHint:
        'This tab is running an older version, whose files are gone. Reload the page to continue. Your message draft is kept and attachments not yet sent are cleared. A MangoStudio response that is running stops (you can resume it); an external agent keeps working.',
    },
    bootstrap: {
      title: 'MangoStudio could not finish loading',
      lead: 'One of the requests every page depends on was refused.',
      rateLimited: 'Too many requests came from this address. Wait a moment and try again.',
      retry: 'Try again',
      detail: 'Details: {message}',
      failed: 'Not loaded: {items}.',
      responsibilities: {
        chats: 'your chats',
        catalog: 'the model list',
        agents: 'agent settings',
      },
    },
  },

  models: {
    loading: 'Loading models…',
    unavailable: 'Models unavailable',
    noModelsAvailable: 'No models available',
    preview: 'Preview',
    providerLocked: 'This chat started with {provider}. Start a new chat to use another provider.',
  },

  api: {
    unauthorized: 'Unauthorized',
  },

  generation: {
    toolLoopExhausted: 'The model exceeded the maximum number of tool interactions.',
  },
};
