import type { Chat } from '@mangostudio/shared/chat';
import type { ChatRecord } from '../infrastructure/chat-repository';

export function toPublicChat(record: ChatRecord, contextInfo?: Chat['contextInfo']): Chat {
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    model: record.model,
    textModel: record.textModel,
    imageModel: record.imageModel,
    runner: record.runner,
    runnerPermissions: record.runnerPermissions,
    workdir: record.workdir,
    environmentId: record.environmentId,
    restrictToolsToWorkdir: record.restrictToolsToWorkdir,
    ...(contextInfo !== undefined ? { contextInfo } : {}),
  };
}
