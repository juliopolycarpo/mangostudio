import type {
  ExternalActivityResult,
  ExternalActivityUpdate,
  ExternalActivityView,
  ExternalAgentCommand,
  ExternalAgentConfiguration,
  ExternalAgentError,
  ExternalAgentEvent,
  ExternalAgentModel,
  ExternalAgentOpenResult,
  ExternalAgentReasoningEffort,
  ExternalAgentRuntimeDescriptor,
  ExternalApprovalOption,
  ExternalApprovalRequest,
  ExternalNativeSession,
  ExternalSupportedConfiguration,
  ExternalTextLimit,
} from '@mangostudio/shared/external-agents';
import {
  boundVendorText,
  EXTERNAL_COMMAND_CATALOG_MAX_ITEMS,
  sanitizeVendorText,
} from '@mangostudio/shared/external-agents';

/**
 * Normalizes display text and refuses rewritten opaque ids at the adapter
 * boundary. Truncating a label is safe; truncating an id that must later be
 * echoed to the vendor would silently point at a different object.
 */
export function normalizeExternalAgentDescriptor(
  descriptor: ExternalAgentRuntimeDescriptor
): ExternalAgentRuntimeDescriptor {
  return {
    ...descriptor,
    ...(descriptor.version
      ? { version: displayText(descriptor.version, 'accountLabel').text }
      : {}),
    ...(descriptor.loginCommand
      ? { loginCommand: displayText(descriptor.loginCommand, 'accountLabel').text }
      : {}),
    supportedConfigurations: descriptor.supportedConfigurations.map(
      normalizeSupportedConfiguration
    ),
    ...(descriptor.models ? { models: descriptor.models.map(normalizeModel) } : {}),
    ...(descriptor.account
      ? {
          account: {
            ...descriptor.account,
            label: displayText(descriptor.account.label, 'accountLabel').text,
            ...(descriptor.account.planType !== undefined
              ? { planType: displayText(descriptor.account.planType, 'accountLabel').text }
              : {}),
          },
        }
      : {}),
  };
}

export function normalizeExternalAgentOpenResult(
  result: ExternalAgentOpenResult
): ExternalAgentOpenResult {
  return {
    ...result,
    nativeSessionId: safeVendorId(result.nativeSessionId, 'native session id'),
    ...(result.fallbackReason !== undefined
      ? { fallbackReason: displayText(result.fallbackReason, 'errorMessage').text }
      : {}),
    effectiveConfiguration: normalizeConfiguration(result.effectiveConfiguration),
  };
}

export function normalizeExternalAgentTurnId(raw: string): string {
  return safeVendorId(raw, 'native turn id');
}

/**
 * Bounds a listing before it becomes a picker.
 *
 * Titles and previews are third-party text rendered in MangoStudio's UI, so
 * they go through the same cut every other vendor label does. A row whose id
 * could not survive `vendorId` bounding is **dropped** rather than repaired:
 * a truncated session id is a pointer to a different conversation, and adopting
 * one would be worse than not offering it.
 *
 * The workspace path is sanitized but not cut to a label's length — it is a
 * path the vendor will be asked about again, and a shortened one names nothing.
 * An unbounded one is dropped for the same reason a bad id is.
 */
export function normalizeExternalNativeSessions(
  sessions: readonly ExternalNativeSession[]
): ExternalNativeSession[] {
  const normalized: ExternalNativeSession[] = [];
  for (const session of sessions) {
    const id = boundVendorText(session.nativeSessionId, 'vendorId');
    if (id.truncated || id.text.length === 0) continue;

    const title =
      session.title === undefined ? undefined : displayText(session.title, 'sessionTitle');
    const preview =
      session.preview === undefined ? undefined : displayText(session.preview, 'sessionTitle');
    const workspacePath =
      session.workspacePath === undefined ? undefined : sanitizeVendorText(session.workspacePath);
    if (workspacePath && (workspacePath.truncated || workspacePath.text.length > MAX_PATH_LENGTH)) {
      continue;
    }

    normalized.push({
      targetId: session.targetId,
      nativeSessionId: id.text,
      ...(title && title.text.length > 0 ? { title: title.text } : {}),
      ...(preview && preview.text.length > 0 ? { preview: preview.text } : {}),
      ...(workspacePath && workspacePath.text.length > 0
        ? { workspacePath: workspacePath.text }
        : {}),
      ...(session.updatedAtMs === undefined ? {} : { updatedAtMs: session.updatedAtMs }),
    });
  }
  return normalized;
}

/** Matches `ExternalNativeSessionSchema.workspacePath`'s bound. */
const MAX_PATH_LENGTH = 4_096;

export function normalizeExternalAgentEvent(event: ExternalAgentEvent): ExternalAgentEvent {
  switch (event.type) {
    case 'session_started':
      return { ...event, sessionId: safeVendorId(event.sessionId, 'session event id') };
    case 'text_delta':
    case 'reasoning_delta':
      return { ...event, text: sanitizeVendorText(event.text).text };
    case 'activity_started':
      return {
        ...event,
        callId: safeVendorId(event.callId, 'activity call id'),
        activity: normalizeActivity(event.activity),
      };
    case 'activity_updated':
      return {
        ...event,
        callId: safeVendorId(event.callId, 'activity call id'),
        update: normalizeActivityUpdate(event.update),
      };
    case 'activity_completed':
      return {
        ...event,
        callId: safeVendorId(event.callId, 'activity call id'),
        result: normalizeActivityResult(event.result),
      };
    case 'approval_requested':
      return { ...event, request: normalizeApprovalRequest(event.request) };
    case 'approval_resolved':
      return {
        ...event,
        requestId: safeVendorId(event.requestId, 'approval request id'),
        decision: {
          ...event.decision,
          optionId: safeVendorId(event.decision.optionId, 'approval option id'),
        },
      };
    case 'commands_available':
      return { ...event, commands: normalizeCommands(event.commands) };
    case 'error':
      return { ...event, error: normalizeError(event.error) };
    case 'usage':
    case 'thread_usage':
    case 'account_limits':
    case 'cancelled':
    case 'completed':
    // No vendor text to bound — the whole event is its `type`.
    case 'reasoning_started':
    case 'reasoning_ended':
      return event;
  }
}

function normalizeConfiguration(
  configuration: ExternalAgentConfiguration
): ExternalAgentConfiguration {
  return {
    ...configuration,
    ...(configuration.model !== undefined
      ? { model: safeVendorId(configuration.model, 'model id') }
      : {}),
    ...(configuration.effort !== undefined
      ? { effort: safeVendorId(configuration.effort, 'reasoning effort id') }
      : {}),
  };
}

function normalizeSupportedConfiguration(
  configuration: ExternalSupportedConfiguration
): ExternalSupportedConfiguration {
  return {
    ...configuration,
    ...(configuration.vendorId !== undefined
      ? { vendorId: safeVendorId(configuration.vendorId, 'configuration id') }
      : {}),
  };
}

function normalizeModel(model: ExternalAgentModel): ExternalAgentModel {
  return {
    ...model,
    id: safeVendorId(model.id, 'model id'),
    ...(model.displayName !== undefined
      ? { displayName: displayText(model.displayName, 'title').text }
      : {}),
    ...(model.description !== undefined
      ? { description: displayText(model.description, 'detail').text }
      : {}),
    ...(model.inputModalities
      ? {
          inputModalities: model.inputModalities.map((value) =>
            safeVendorId(value, 'input modality')
          ),
        }
      : {}),
    ...(model.supportedReasoningEfforts
      ? { supportedReasoningEfforts: model.supportedReasoningEfforts.map(normalizeReasoningEffort) }
      : {}),
    ...(model.defaultReasoningEffort !== undefined
      ? {
          defaultReasoningEffort: safeVendorId(
            model.defaultReasoningEffort,
            'default reasoning effort id'
          ),
        }
      : {}),
    ...(model.serviceTiers
      ? { serviceTiers: model.serviceTiers.map((value) => safeVendorId(value, 'service tier id')) }
      : {}),
  };
}

function normalizeReasoningEffort(
  effort: ExternalAgentReasoningEffort
): ExternalAgentReasoningEffort {
  return {
    ...effort,
    id: safeVendorId(effort.id, 'reasoning effort id'),
    ...(effort.displayName !== undefined
      ? { displayName: displayText(effort.displayName, 'title').text }
      : {}),
    ...(effort.description !== undefined
      ? { description: displayText(effort.description, 'detail').text }
      : {}),
  };
}

function normalizeActivity(activity: ExternalActivityView): ExternalActivityView {
  const name = displayText(activity.name, 'activityName');
  const title = displayText(activity.title, 'title');
  const detail = activity.detail === undefined ? undefined : displayText(activity.detail, 'detail');
  const truncated =
    activity.truncated === true || name.truncated || title.truncated || detail?.truncated;
  return {
    ...activity,
    name: name.text,
    title: title.text,
    ...(detail ? { detail: detail.text } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

function normalizeActivityUpdate(update: ExternalActivityUpdate): ExternalActivityUpdate {
  const title = update.title === undefined ? undefined : displayText(update.title, 'title');
  const detail = update.detail === undefined ? undefined : displayText(update.detail, 'detail');
  const truncated = update.truncated === true || title?.truncated || detail?.truncated;
  return {
    ...update,
    ...(title ? { title: title.text } : {}),
    ...(detail ? { detail: detail.text } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

function normalizeActivityResult(result: ExternalActivityResult): ExternalActivityResult {
  const detail = result.detail === undefined ? undefined : displayText(result.detail, 'detail');
  return {
    ...result,
    ...(detail ? { detail: detail.text } : {}),
    ...(result.truncated === true || detail?.truncated ? { truncated: true } : {}),
  };
}

function normalizeApprovalRequest(request: ExternalApprovalRequest): ExternalApprovalRequest {
  const title = displayText(request.title, 'title');
  const detail = request.detail === undefined ? undefined : displayText(request.detail, 'detail');
  const options = request.options.map(normalizeApprovalOption);
  const optionTruncated = request.options.some((option, index) => {
    const normalized = options[index];
    return option.rawLabel !== normalized?.rawLabel;
  });
  return {
    ...request,
    requestId: safeVendorId(request.requestId, 'approval request id'),
    title: title.text,
    ...(detail ? { detail: detail.text } : {}),
    options,
    ...(request.truncated === true || title.truncated || detail?.truncated || optionTruncated
      ? { truncated: true }
      : {}),
  };
}

function normalizeApprovalOption(option: ExternalApprovalOption): ExternalApprovalOption {
  return {
    ...option,
    id: safeVendorId(option.id, 'approval option id'),
    ...(option.rawLabel !== undefined
      ? { rawLabel: displayText(option.rawLabel, 'approvalOptionLabel').text }
      : {}),
  };
}

/**
 * Bounds a slash-command catalog, dropping rows that cannot be offered.
 *
 * A name is **dropped** rather than truncated, on the same terms as a session
 * id: the palette inserts it into the composer for the vendor to expand, so a
 * shortened name is a command the CLI does not have. A description is display
 * text and is cut like every other label. Over-long catalogs are cut to the
 * contract's ceiling here, because emitting a longer one fails validation in
 * the supervisor and ends the turn — a far worse answer to a big command list
 * than a shorter list.
 */
function normalizeCommands(
  commands: readonly ExternalAgentCommand[]
): readonly ExternalAgentCommand[] {
  const normalized: ExternalAgentCommand[] = [];
  const seen = new Set<string>();
  for (const command of commands) {
    if (normalized.length >= EXTERNAL_COMMAND_CATALOG_MAX_ITEMS) break;
    const name = boundVendorText(command.name, 'commandName');
    if (name.truncated || name.text.length === 0 || /\s/u.test(name.text) || seen.has(name.text)) {
      continue;
    }
    seen.add(name.text);

    const description =
      command.description === undefined
        ? undefined
        : displayText(command.description, 'commandDescription');
    normalized.push({
      name: name.text,
      ...(description && description.text.length > 0 ? { description: description.text } : {}),
    });
  }
  return normalized;
}

function normalizeError(error: ExternalAgentError): ExternalAgentError {
  const message = displayText(error.message, 'errorMessage');
  return {
    ...error,
    code: safeVendorId(error.code, 'error code'),
    message: message.text,
    ...(error.requestId !== undefined
      ? { requestId: safeVendorId(error.requestId, 'error request id') }
      : {}),
    ...(error.vendorCode !== undefined
      ? { vendorCode: safeVendorId(error.vendorCode, 'vendor error code') }
      : {}),
    ...(error.truncated === true || message.truncated ? { truncated: true } : {}),
  };
}

function displayText(raw: string, limit: ExternalTextLimit) {
  return boundVendorText(raw, limit);
}

function safeVendorId(raw: string, label: string): string {
  const bounded = boundVendorText(raw, 'vendorId');
  if (bounded.truncated || bounded.text.length === 0) {
    throw new Error(`External-agent adapter returned an invalid ${label}.`);
  }
  return bounded.text;
}
