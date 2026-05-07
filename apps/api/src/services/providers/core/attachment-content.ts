import type { ModelCapabilities, ProviderRuntimeAttachment } from '../types';

export type ProviderSupportedAttachmentKind = 'image' | 'pdf' | 'text';

export function attachmentToBase64(attachment: ProviderRuntimeAttachment): string {
  return Buffer.from(attachment.bytes).toString('base64');
}

export function attachmentToDataUrl(attachment: ProviderRuntimeAttachment): string {
  return `data:${attachment.mimeType};base64,${attachmentToBase64(attachment)}`;
}

export function isAttachmentSupportedByProvider(
  attachment: ProviderRuntimeAttachment,
  capabilities: ModelCapabilities | undefined,
  supportedKinds: readonly ProviderSupportedAttachmentKind[]
): boolean {
  const supportKind = getAttachmentSupportKind(attachment);
  if (!supportKind) return false;
  return (
    isAttachmentSupportedByModel(attachment, capabilities) && supportedKinds.includes(supportKind)
  );
}

export function unsupportedAttachmentNotes(
  attachments: readonly ProviderRuntimeAttachment[] | undefined,
  capabilities: ModelCapabilities | undefined,
  supportedKinds: readonly ProviderSupportedAttachmentKind[] = []
): string[] {
  return (attachments ?? [])
    .filter(
      (attachment) => !isAttachmentSupportedByProvider(attachment, capabilities, supportedKinds)
    )
    .map((attachment) => formatUnsupportedAttachmentNote(attachment, capabilities, supportedKinds));
}

export function appendAttachmentFallbackNotes(
  prompt: string,
  attachments: readonly ProviderRuntimeAttachment[] | undefined,
  capabilities: ModelCapabilities | undefined,
  supportedKinds: readonly ProviderSupportedAttachmentKind[] = []
): string {
  const notes = unsupportedAttachmentNotes(attachments, capabilities, supportedKinds);
  if (notes.length === 0) return prompt;

  const noteText = notes.join('\n');
  return prompt.trim().length > 0 ? `${prompt}\n\n${noteText}` : noteText;
}

export function isAttachmentSupportedByModel(
  attachment: ProviderRuntimeAttachment,
  capabilities: ModelCapabilities | undefined
): boolean {
  if (!capabilities?.fileAttachments) return false;

  switch (getAttachmentSupportKind(attachment)) {
    case 'image':
      return capabilities.imageInput === true;
    case 'pdf':
      return capabilities.pdfInput === true;
    case 'text':
      return capabilities.textFileInput === true;
    default:
      return false;
  }
}

export function getAttachmentSupportKind(
  attachment: ProviderRuntimeAttachment
): ProviderSupportedAttachmentKind | undefined {
  if (attachment.kind === 'image' || attachment.mimeType.startsWith('image/')) return 'image';
  if (attachment.kind === 'pdf' || attachment.mimeType === 'application/pdf') return 'pdf';
  if (attachment.kind === 'text' || isTextLikeMimeType(attachment.mimeType)) return 'text';
  return undefined;
}

function formatUnsupportedAttachmentNote(
  attachment: ProviderRuntimeAttachment,
  capabilities: ModelCapabilities | undefined,
  supportedKinds: readonly ProviderSupportedAttachmentKind[]
): string {
  const reason = unsupportedAttachmentReason(attachment, capabilities, supportedKinds);
  return `[Attachment ${JSON.stringify(attachment.originalName)} (${attachment.mimeType}, ${attachment.sizeBytes} bytes) was not sent because ${reason}.]`;
}

function unsupportedAttachmentReason(
  attachment: ProviderRuntimeAttachment,
  capabilities: ModelCapabilities | undefined,
  supportedKinds: readonly ProviderSupportedAttachmentKind[]
): string {
  const supportKind = getAttachmentSupportKind(attachment);
  if (!supportKind) return 'this attachment type is not supported';
  if (!capabilities?.fileAttachments) return 'this model does not support attachments';

  if (!isAttachmentSupportedByModel(attachment, capabilities)) {
    switch (supportKind) {
      case 'image':
        return 'this model does not support image attachments';
      case 'pdf':
        return 'this model does not support PDF attachments';
      case 'text':
        return 'this model does not support text file attachments';
    }
  }

  if (!supportedKinds.includes(supportKind)) {
    return `this provider path does not support ${attachmentKindLabel(supportKind)} attachments`;
  }

  return 'this attachment could not be mapped for this provider path';
}

function attachmentKindLabel(kind: ProviderSupportedAttachmentKind): string {
  return kind === 'pdf' ? 'PDF' : kind;
}

function isTextLikeMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/x-ndjson'
  );
}
