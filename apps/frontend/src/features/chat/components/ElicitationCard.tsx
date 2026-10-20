/**
 * Interactive card for an MCP form elicitation mid tool call. Posts accept /
 * decline / cancel to `POST /mcp/elicitations/:id/respond` so the awaited MCP
 * call can resume. Unlike QuestionCard, this stays interactive while the turn
 * is still streaming.
 */

import type {
  McpElicitationField,
  McpElicitationStatus,
  RespondMcpElicitationBody,
} from '@mangostudio/shared/mcp';
import type { MessagePart } from '@mangostudio/shared/types';
import { useQueryClient } from '@tanstack/react-query';
import { Check, CircleHelp } from 'lucide-react';
import { useState } from 'react';
import { messageKeys } from '@/features/chat/queries';
import { useI18n } from '@/hooks/use-i18n';
import { McpElicitationGoneError, respondMcpElicitation } from '@/services/mcp-elicitation-service';

type ElicitationPart = Extract<MessagePart, { type: 'mcp_elicitation' }>;

type FieldValue = string | number | boolean | string[];

interface ElicitationCardProps {
  part: ElicitationPart;
}

/**
 * Usage: <ElicitationCard part={part} />
 */
export function ElicitationCard({ part }: ElicitationCardProps) {
  const { t } = useI18n();
  const labels = t.chat.elicitation;
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Record<string, FieldValue>>(() =>
    initialValues(part.fields)
  );
  const [optimisticStatus, setOptimisticStatus] = useState<McpElicitationStatus | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The server part is authoritative: any terminal status streamed or
  // refetched into the prop wins over local submission state.
  const status = part.status !== 'pending' ? part.status : (optimisticStatus ?? 'pending');
  const interactive = status === 'pending';

  const setField = (name: string, value: FieldValue) => {
    setValues((current) => ({ ...current, [name]: value }));
  };

  const requiredFilled = part.fields.every((field) => {
    if (!field.required) return true;
    const value = values[field.name];
    if (field.kind === 'boolean') return typeof value === 'boolean';
    if (field.kind === 'multi_enum') return Array.isArray(value) && value.length > 0;
    if (field.kind === 'number' || field.kind === 'integer') {
      return typeof value === 'number' && !Number.isNaN(value);
    }
    return typeof value === 'string' && value.trim().length > 0;
  });

  const respond = async (body: RespondMcpElicitationBody) => {
    if (!interactive || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await respondMcpElicitation(part.elicitationId, body);
      setOptimisticStatus(result.status);
    } catch (respondError) {
      if (respondError instanceof McpElicitationGoneError) {
        // Stale card: the server already resolved this elicitation. Refetch
        // the owning messages so the persisted terminal state (if any)
        // replaces the pending prop instead of inventing a status here.
        await queryClient.invalidateQueries({ queryKey: messageKeys.lists() });
      } else {
        setError(labels.submitError);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const title =
    status === 'pending'
      ? labels.title
      : status === 'accepted'
        ? labels.answered
        : status === 'declined'
          ? labels.declined
          : labels.cancelled;

  return (
    <div className="max-w-2xl w-full rounded-2xl border border-stroke bg-surface p-4 sm:p-5 text-sm text-fg space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-fg-muted">
        <CircleHelp size={16} className="text-accent-fg" />
        <span className="text-xs font-bold uppercase tracking-widest">{title}</span>
        <span className="rounded-full bg-surface px-2 py-0.5 text-xs">
          {labels.fromServer.replace('{server}', part.serverSlug)}
        </span>
      </div>

      <p className="font-medium text-fg whitespace-pre-wrap">{part.message}</p>

      {part.fields.map((field) => (
        <FieldEditor
          key={field.name}
          field={field}
          value={values[field.name]}
          interactive={interactive}
          multiSelectHint={labels.multiSelectHint}
          requiredHint={labels.requiredHint}
          booleanTrue={labels.booleanTrue}
          booleanFalse={labels.booleanFalse}
          onChange={(value) => setField(field.name, value)}
        />
      ))}

      {interactive && error && <p className="text-xs text-danger">{error}</p>}

      {interactive && (
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            disabled={submitting}
            onClick={() => void respond({ action: 'cancel' })}
            className="rounded-xl border border-stroke px-3 py-2 text-sm text-fg-muted transition-colors hover:bg-fill-hover cursor-pointer disabled:opacity-40"
          >
            {labels.cancel}
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void respond({ action: 'decline' })}
            className="rounded-xl border border-stroke px-3 py-2 text-sm text-fg-muted transition-colors hover:bg-fill-hover cursor-pointer disabled:opacity-40"
          >
            {labels.decline}
          </button>
          <button
            type="button"
            disabled={!requiredFilled || submitting}
            onClick={() =>
              void respond({
                action: 'accept',
                content: buildContent(part.fields, values),
              })
            }
            className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-opacity duration-150 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
          >
            {labels.submit}
          </button>
        </div>
      )}
    </div>
  );
}

function FieldEditor({
  field,
  value,
  interactive,
  multiSelectHint,
  requiredHint,
  booleanTrue,
  booleanFalse,
  onChange,
}: {
  field: McpElicitationField;
  value: FieldValue | undefined;
  interactive: boolean;
  multiSelectHint: string;
  requiredHint: string;
  booleanTrue: string;
  booleanFalse: string;
  onChange: (value: FieldValue) => void;
}) {
  const label = field.title ?? field.name;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium text-fg">{label}</p>
        {field.required && <span className="text-xs text-fg-muted">{requiredHint}</span>}
      </div>
      {field.description && <p className="text-xs text-fg-muted">{field.description}</p>}

      {field.kind === 'enum' || field.kind === 'multi_enum' ? (
        <>
          {field.kind === 'multi_enum' && (
            <p className="text-xs text-fg-muted">{multiSelectHint}</p>
          )}
          <div className="space-y-1.5">
            {(field.options ?? []).map((option) => {
              const selected =
                field.kind === 'multi_enum'
                  ? Array.isArray(value) && value.includes(option.value)
                  : value === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  disabled={!interactive}
                  onClick={() => {
                    if (field.kind === 'multi_enum') {
                      const current = Array.isArray(value) ? value : [];
                      onChange(
                        selected
                          ? current.filter((entry) => entry !== option.value)
                          : [...current, option.value]
                      );
                      return;
                    }
                    onChange(selected ? '' : option.value);
                  }}
                  className={`flex w-full items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors duration-150 ${
                    selected ? 'border-accent bg-accent-subtle' : 'border-stroke bg-surface'
                  } ${interactive ? 'cursor-pointer hover:border-stroke' : 'cursor-default opacity-70'}`}
                >
                  <span
                    className={`mt-0.5 text-xs font-semibold ${selected ? 'text-accent-fg' : 'text-fg-muted'}`}
                  >
                    {selected ? <Check size={14} /> : '○'}
                  </span>
                  <span className="min-w-0 flex-1 font-medium text-fg">{option.label}</span>
                </button>
              );
            })}
          </div>
        </>
      ) : field.kind === 'boolean' ? (
        <div className="flex gap-2">
          {[true, false].map((option) => {
            const selected = value === option;
            return (
              <button
                key={String(option)}
                type="button"
                disabled={!interactive}
                onClick={() => onChange(option)}
                className={`rounded-xl border px-3 py-2 text-sm transition-colors ${
                  selected
                    ? 'border-accent bg-accent-subtle text-fg'
                    : 'border-stroke bg-surface text-fg-muted'
                } ${interactive ? 'cursor-pointer' : 'cursor-default opacity-70'}`}
              >
                {option ? booleanTrue : booleanFalse}
              </button>
            );
          })}
        </div>
      ) : (
        <input
          type={
            field.kind === 'number' || field.kind === 'integer'
              ? 'number'
              : field.format === 'email'
                ? 'email'
                : field.format === 'uri'
                  ? 'url'
                  : field.format === 'date'
                    ? 'date'
                    : field.format === 'date-time'
                      ? 'datetime-local'
                      : 'text'
          }
          disabled={!interactive}
          value={typeof value === 'number' || typeof value === 'string' ? value : ''}
          min={field.minimum}
          max={field.maximum}
          minLength={field.minLength}
          maxLength={field.maxLength}
          step={field.kind === 'integer' ? 1 : undefined}
          onChange={(event) => {
            if (field.kind === 'number' || field.kind === 'integer') {
              const next = event.target.value;
              onChange(next === '' ? Number.NaN : Number(next));
              return;
            }
            onChange(event.target.value);
          }}
          className="w-full rounded-xl border border-stroke bg-surface px-3 py-2 text-sm text-fg focus:border-focus focus:outline-none disabled:opacity-70"
        />
      )}
    </div>
  );
}

function initialValues(fields: ReadonlyArray<McpElicitationField>): Record<string, FieldValue> {
  const values: Record<string, FieldValue> = {};
  for (const field of fields) {
    if (field.default !== undefined) {
      values[field.name] = field.default;
      continue;
    }
    if (field.kind === 'boolean') values[field.name] = false;
    else if (field.kind === 'multi_enum') values[field.name] = [];
    else if (field.kind === 'number' || field.kind === 'integer') values[field.name] = Number.NaN;
    else values[field.name] = '';
  }
  return values;
}

function buildContent(
  fields: ReadonlyArray<McpElicitationField>,
  values: Record<string, FieldValue>
): Record<string, string | number | boolean | string[]> {
  const content: Record<string, string | number | boolean | string[]> = {};
  for (const field of fields) {
    const value = values[field.name];
    if (value === undefined) continue;
    if (field.kind === 'number' || field.kind === 'integer') {
      if (typeof value !== 'number' || Number.isNaN(value)) continue;
      content[field.name] = value;
      continue;
    }
    if (field.kind === 'multi_enum') {
      if (!Array.isArray(value) || value.length === 0) continue;
      content[field.name] = value;
      continue;
    }
    if (field.kind === 'boolean') {
      if (typeof value !== 'boolean') continue;
      content[field.name] = value;
      continue;
    }
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    content[field.name] = value;
  }
  return content;
}
