import type { AuthUser } from '../auth/contracts';
import type {
  Chat,
  GalleryItem,
  GeneratedImageArtifact,
  Message,
  SecretMetadataRow,
} from '../types';
import { fixtures } from './fixtures';

/**
 * Standard mock models for consistent testing across API and Frontend.
 */
export const MOCK_MODELS = {
  text: {
    id: 'gemini-2.5-flash',
    name: 'models/gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    description: 'Fast and versatile model for most tasks.',
  },
  image: {
    id: 'gemini-2.0-flash-exp-image',
    name: 'models/gemini-2.0-flash-exp-image',
    displayName: 'Gemini 2.0 Flash (Image)',
    description: 'Specialized for high-quality image generation.',
  },
};

/** Restarts the shared fixture sequence for compatibility. Example: seedFaker(42). */
export function seedFaker(seed: number): void {
  fixtures.seed(seed);
}

/** Creates a user fixture. Example: createMockUser({ name: 'Test User' }). */
export function createMockUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: fixtures.uuid(),
    name: fixtures.name(),
    email: fixtures.email(),
    emailVerified: false,
    ...overrides,
  };
}

/** Creates a chat fixture with ordered timestamps. Example: createMockChat({ title: 'Test' }). */
export function createMockChat(overrides: Partial<Chat> = {}): Chat {
  const now = Date.now();
  return {
    id: fixtures.uuid(),
    title: fixtures.words(3),
    createdAt: now - 1000,
    updatedAt: now,
    model: null,
    textModel: MOCK_MODELS.text.id,
    imageModel: MOCK_MODELS.image.id,
    runner: { kind: 'mangostudio', agentId: 'default' },
    runnerPermissions: {},
    runnerModelSelection: {},
    workdir: null,
    environmentId: 'local',
    restrictToolsToWorkdir: null,
    ...overrides,
  };
}

/** Creates a message fixture. Example: createMockMessage({ chatId: chat.id }). */
export function createMockMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: fixtures.uuid(),
    chatId: fixtures.uuid(),
    role: 'user',
    text: fixtures.sentence(),
    interactionMode: 'chat',
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * Converts internal models to API-compatible JSON structures.
 * Timestamps are already epoch ms numbers — no conversion needed.
 */
export const toApiResponse = {
  chat: (chat: Chat) => ({ ...chat }),
  message: (msg: Message) => ({ ...msg }),
};

/** Creates an image fixture. Example: createMockGeneratedImageArtifact({ messageId: message.id }). */
export function createMockGeneratedImageArtifact(
  overrides: Partial<GeneratedImageArtifact> = {}
): GeneratedImageArtifact {
  return {
    id: fixtures.uuid(),
    chatId: fixtures.uuid(),
    messageId: fixtures.uuid(),
    prompt: fixtures.sentence(),
    imageUrl: `/images/${fixtures.fileName()}.png`,
    createdAt: Date.now(),
    ...overrides,
  };
}

/** Creates a gallery fixture. Example: createMockGalleryItem({ prompt: 'Mangoes' }). */
export function createMockGalleryItem(overrides: Partial<GalleryItem> = {}): GalleryItem {
  return createMockGeneratedImageArtifact(overrides);
}

/** Creates connector metadata. Example: createMockSecretMetadataRow({ provider: 'gemini' }). */
export function createMockSecretMetadataRow(
  overrides: Partial<SecretMetadataRow> = {}
): SecretMetadataRow {
  const now = Date.now();
  return {
    id: fixtures.uuid(),
    name: fixtures.companyName(),
    provider: 'gemini',
    configured: 1,
    source: 'bun-secrets',
    maskedSuffix: fixtures.suffix(),
    updatedAt: now,
    lastValidatedAt: now - 60_000,
    lastValidationError: null,
    enabledModels: JSON.stringify(['gemini-pro', 'gemini-flash']),
    userId: null,
    baseUrl: null,
    ...overrides,
  };
}

export const mockChats: Chat[] = [
  createMockChat({ id: 'chat-1', title: 'First Chat' }),
  createMockChat({ id: 'chat-2', title: 'Second Chat' }),
];

export const mockMessages: Message[] = [
  createMockMessage({
    id: 'msg-1',
    chatId: 'chat-1',
    role: 'user',
    text: 'Hello, how are you?',
    interactionMode: 'chat',
  }),
  createMockMessage({
    id: 'msg-2',
    chatId: 'chat-1',
    role: 'ai',
    text: 'I am doing well, thank you!',
    interactionMode: 'chat',
    modelName: MOCK_MODELS.text.id,
  }),
];

export const mockGalleryItems: GalleryItem[] = [
  createMockGalleryItem({ id: 'gallery-1', prompt: 'A sunset over mountains' }),
  createMockGalleryItem({ id: 'gallery-2', prompt: 'A futuristic city' }),
];
