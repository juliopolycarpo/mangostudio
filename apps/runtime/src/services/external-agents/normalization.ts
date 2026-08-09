import type {
  ExternalActivityResult,
  ExternalActivityUpdate,
  ExternalActivityView,
  ExternalAgentConfiguration,
  ExternalAgentError,
  ExternalAgentEvent,
  ExternalAgentModel,
  ExternalAgentOpenResult,
  ExternalAgentReasoningEffort,
  ExternalAgentRuntimeDescriptor,
  ExternalApprovalOption,
  ExternalApprovalRequest,
  ExternalSupportedConfiguration,
  ExternalTextLimit,
} from '@mangostudio/shared/external-agents';
import { boundVendorText, sanitizeVendorText } from '@mangostudio/shared/external-agents';

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
    case 'error':
      return { ...event, error: normalizeError(event.error) };
    case 'usage':
    case 'completed':
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
