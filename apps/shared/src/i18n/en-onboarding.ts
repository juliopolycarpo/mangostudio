import type { Messages } from './types';

/**
 * The English `onboarding` namespace. It is not part of the eager dictionary:
 * the frontend loads it with the setup flow (see `lib/locale-dictionaries.ts`).
 */
export const messages: Pick<Messages, 'onboarding'> = {
  onboarding: {
    progress: 'Step {step} of {total} · {name}',
    stepList: 'Setup steps',
    back: 'Back',
    continue: 'Continue',
    skipStep: 'Skip for now',
    skipAll: 'Skip setup',
    finish: 'Open MangoStudio',
    deciding: 'Checking what this machine already has…',
    saveFailed: 'Your progress could not be saved. Nothing was lost — try again.',
    status: {
      satisfied: 'Done',
      skipped: 'Skipped',
      pending: 'To do',
      unknown: 'Checking',
      unavailable: 'Unavailable',
    },
    steps: {
      welcome: 'Welcome',
      folder: 'Folder',
      toolchain: 'Toolchain',
      agents: 'Agents',
      service: 'Always on',
      chat: 'First chat',
    },
    welcome: {
      title: 'MangoStudio runs coding agents on your own machine',
      lead: 'Your files stay here, the agent runs here, and nothing happens until you ask for it.',
      folderPoint:
        'You point it at a folder. That folder is the project the agent reads and edits.',
      runnerPoint:
        'You choose who answers: a model you bring an API key for, or a coding agent CLI already installed on this computer.',
      controlPoint:
        'Every step here can be skipped and redone later from Settings. None of them is a one-way door.',
      action: 'Get started',
    },
    folder: {
      title: 'Choose the folder to work in',
      lead: 'This is the project the agent reads and edits. The root of a repository is usually the right choice.',
      hint: 'Each chat can use a different folder later; this only sets where the first one starts.',
      machineLabel: 'Machine',
      machineHint:
        'Local is the computer running MangoStudio. Machines you add later appear here too.',
      choose: 'Choose a folder',
      change: 'Change folder',
      selected: 'Working in',
      empty: 'No folder chosen yet.',
    },
    toolchain: {
      title: 'Check the toolchain',
      lead: 'Agents run commands in your project — tests, builds, scripts. Those need Node or Bun on this machine.',
      hint: 'Missing one is not fatal: chat still works, and only the commands that need it will fail.',
      ready: 'Ready',
      missing: 'Not found',
      probeFailed:
        'This machine could not be asked which runtimes it has. That is not the same as having none \u2014 try again, or skip this step and check the toolchain later.',
    },
    agents: {
      title: 'Choose who answers',
      lead: 'A chat is answered either by a model you configure with an API key, or by a coding agent CLI already installed here.',
      hint: 'Agent CLIs sign in with their own vendor account, in their own terminal. MangoStudio never sees those credentials.',
      cliHeading: 'Agent CLIs on this machine',
      modelDescription: 'Uses your own API key. Nothing to install.',
      noneFound: 'No agent CLI was found here.',
      probeFailed:
        'This machine could not be asked which agent CLIs it has. That is not the same as having none \u2014 try again, or skip this step and pick a runner later.',
      noModels:
        'No model provider is configured yet, so MangoStudio cannot answer on its own. Add a key under Settings \u2192 Providers once setup is done, or pick an agent CLI below.',
      signedIn: 'Signed in',
      signedOut: 'Not signed in',
      // The command beneath it belongs to one agent; the line says which.
      signInHint: 'Sign in from a terminal on this machine, then come back.',
      isolated:
        'Another account is already using this computer’s agent sign-ins, so they are not offered to you here. Use a model instead, or skip this step and add a machine of your own from Environments afterwards.',
    },
    service: {
      title: 'Keep it running',
      lead: 'As a background service, MangoStudio comes back on its own after you log out or restart.',
      hint: 'Optional. Without it, MangoStudio runs only while the terminal that started it stays open.',
      installed: 'Installed',
      notInstalled: 'Not installed',
      /** Title when the supervisor could not be asked; the coded reason, when there is one, and the raw line sit beneath. */
      unreadable: 'Could not check the service',
      install: 'Install the service',
      installing: 'Installing…',
      commandTitle: 'Run this on the computer hosting MangoStudio:',
    },
    chat: {
      title: 'Ask your first question',
      lead: 'This opens one chat in the folder you chose and sends a first message, so you can watch the whole loop work.',
      hint: 'The starting message is only a suggestion — edit it, or write your own.',
      promptLabel: 'First message',
      defaultPrompt:
        'Take a look at this project and tell me in a short paragraph what it does and how it is organised.',
      send: 'Send it',
      sending: 'Opening the chat…',
      answered: 'It answered. Setup is done.',
      operationStates: {
        accepted: 'The request was accepted.',
        running: 'The accepted request is running.',
        completed: 'The request completed. Open the chat to see the result.',
        failed: 'The accepted request failed. You can start a new request.',
        unresolved:
          'The result is uncertain. Check the chat before starting a new request; work may already have run.',
      },
      operationUnavailable: 'The request status is unavailable. Try checking again.',
      operationExpired: 'The request record expired. Check the chat before starting a new request.',
      retryStatus: 'Check status again',
      recoveryFailed: 'The chat was created, but setup could not save it. Try saving again.',
      chatUnavailable: 'This setup chat is no longer available. You can start a new chat.',
      retryRecovery: 'Save the chat again',
      newRequest: 'Start a new request',
      waiting: 'Waiting for the answer…',
      failed: 'The answer did not arrive. Open the chat and try again there.',
      openChat: 'Open the chat',
      resume: 'This setup already started a chat. Sending again continues that one.',
      needsFolder: 'Choose a folder first, or skip that step.',
      // Navigates to the folder step; it does not open the picker, so it says "go", not "choose".
      goToFolder: 'Go to the folder step',
      summary: 'Sending to {runner} in {workdir}',
    },
    reenter: {
      title: 'First-run setup',
      description:
        'Walk through the first-run steps again. Nothing is removed — your chats, sign-ins and machine settings stay exactly as they are.',
      action: 'Run setup again',
    },
  },
};
