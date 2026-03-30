import type { Messages } from './types';

export const messages: Messages = {
  auth: {
    loginTitle: 'Mango Studio',
    signupTitle: 'Create Account',
    emailLabel: 'Email',
    emailPlaceholder: 'you@email.com',
    passwordLabel: 'Password',
    passwordPlaceholder: '••••••••',
    signupPasswordLabel: 'Password (8 characters minimum)',
    nameLabel: 'Name',
    namePlaceholder: 'Your name',
    loginButton: 'Sign In',
    loginLoading: 'Signing in...',
    signupButton: 'Create Account',
    signupLoading: 'Creating...',
    loginLink: 'Sign in',
    signupLink: 'Create account',
    noAccount: "Don't have an account?",
    hasAccount: 'Already have an account?',
    loginError: 'Login failed',
    signupError: 'Account creation failed',
    logoutButton: 'Sign Out',
    logoutLoading: 'Signing out...',
    logoutError: 'Logout failed. Please try again.',
  },

  chat: {
    newChat: 'New Chat',
    empty: 'Start a conversation',
    deleted: 'Chat deleted',
    editTitle: 'Edit title',
    deleteTitle: 'Delete chat',
    sectionLabel: 'Chats',
    stopGenerating: 'Stop',
    streaming: 'Generating...',
  },

  gallery: {
    title: 'Gallery',
    empty: 'Your creations will appear here.',
    download: 'Download Full Image',
    view: 'View',
  },

  settings: {
    title: 'Settings',
    tabs: {
      general: 'General',
      connectors: 'Connectors',
    },
    general: {
      languageLabel: 'Language',
      languageDescription: 'User interface language',
      textPromptLabel: 'Default Text System Prompt',
      textPromptPlaceholder:
        'e.g. You are a helpful creative partner. Be concise and insightful...',
      imagePromptLabel: 'Default Image System Prompt',
      imagePromptPlaceholder:
        'e.g. Always generate images in a cinematic style with dramatic lighting...',
      imageQualityLabel: 'Default Image Quality',
    },
    connectors: {
      title: 'AI Connectors',
      addButton: 'Add Connector',
      emptyTitle: 'No Connectors Found',
      emptyDescription: 'Add your first API key to start generating.',
      deleteConfirm: 'Are you sure you want to delete this connector?',
      addModalTitle: 'Add Connector',
      addModalDescription: 'Choose the provider, configure the API key and storage.',
      providerLabel: 'Provider',
      selectProvider: 'Select Provider',
      baseUrlLabel: 'Base URL (optional)',
      baseUrlPlaceholder: 'https://api.example.com/v1',
      nameLabel: 'Name',
      namePlaceholder: 'e.g. Personal Project',
      apiKeyLabel: 'API Key',
      apiKeyPlaceholder: 'sk-...',
      saveToLabel: 'Save To',
      sources: {
        bunSecrets: 'OS Secret Store',
        bunSecretsDesc: 'Native secure storage',
        configFile: 'config.toml',
        configFileDesc: '~/.mango/config.toml',
        envFile: '.env File',
        envFileDesc: 'App root .env',
      },
      cancelButton: 'Cancel',
      addConnectorButton: 'Add Connector',
      validating: 'Validating...',
      modalsModalTitle: 'Choose Available Models',
      modelsModalTitle: 'Choose Available Models',
      modelsModalDescription: 'Models enabled for',
      modelsModalDescriptionSuffix: 'will be available in the chat.',
      textModelsLabel: 'Text Models',
      imageModelsLabel: 'Image Models',
      doneButton: 'Done',
      configureModels: 'Configure Models',
      deleteConnector: 'Delete Connector',
      addSuccess: 'Connector added successfully!',
      deleteSuccess: 'Connector deleted successfully!',
      updateModelsSuccess: 'Models updated successfully!',
      errorRequired: 'Name and API Key are required.',
    },
  },

  common: {
    loading: 'Loading...',
  },

  providers: {
    gemini: 'Google Gemini',
    'openai-compatible': 'OpenAI',
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    deepseek: 'DeepSeek',
    openrouter: 'OpenRouter',
  },

  errors: {
    imageNotSupported: 'This provider does not support image generation.',
    referenceImageUploadFailed: 'Failed to upload reference image. Please try again.',
  },

  api: {
    unauthorized: 'Unauthorized',
  },
};
