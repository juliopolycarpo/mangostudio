/**
 * Interactive card for an MCP form elicitation mid tool call. Posts accept /
 * decline / cancel to `POST /mcp/elicitations/:id/respond` so the awaited MCP
 * call can resume. Unlike QuestionCard, this stays interactive while the turn
 * is still streaming.
 */

import type { MessagePart } from '@mangostudio/shared';
import type { McpElicitationField, RespondMcpElicitationBody } from '@mangostudio/shared/mcp';
import { Check, CircleHelp } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { respondMcpElicitation } from '@/services/mcp-elicitation-service';

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
  const [values, setValues] = useState<Record<string, FieldValue>>(() =>
    initialValues(part.fields)
  );
  const [status, setStatus] = useState(part.status);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      setStatus(result.status);
    } catch {
      setError(labels.submitError);
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
    <div className="max-w-2xl w-full rounded-2xl border border-outline-variant/15 bg-surface-container-low p-4 sm:p-5 text-sm text-on-surface space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-on-surface-variant">
        <CircleHelp size={16} className="text-primary" />
        <span className="text-xs font-bold uppercase tracking-widest">{title}</span>
        <span className="rounded-full bg-surface-container-high px-2 py-0.5 text-xs">
          {labels.fromServer.replace('{server}', part.serverSlug)}
        </span>
      </div>

      <p className="font-medium text-on-surface whitespace-pre-wrap">{part.message}</p>

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

      {error && <p className="text-xs text-error">{error}</p>}

      {interactive && (
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            disabled={submitting}
            onClick={() => void respond({ action: 'cancel' })}
            className="rounded-xl border border-outline-variant/20 px-3 py-2 text-sm text-on-surface-variant transition-colors hover:bg-surface-container-high cursor-pointer disabled:opacity-40"
          >
            {labels.cancel}
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void respond({ action: 'decline' })}
            className="rounded-xl border border-outline-variant/20 px-3 py-2 text-sm text-on-surface-variant transition-colors hover:bg-surface-container-high cursor-pointer disabled:opacity-40"
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
            className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-opacity duration-150 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
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
        <p className="font-medium text-on-surface">{label}</p>
        {field.required && (
          <span className="text-xs text-on-surface-variant/70">{requiredHint}</span>
        )}
      </div>
      {field.description && (
        <p className="text-xs text-on-surface-variant/80">{field.description}</p>
      )}

      {field.kind === 'enum' || field.kind === 'multi_enum' ? (
        <>
          {field.kind === 'multi_enum' && (
            <p className="text-xs text-on-surface-variant/70">{multiSelectHint}</p>
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
                    selected
                      ? 'border-primary/50 bg-primary/10'
                      : 'border-outline-variant/15 bg-surface-container-high'
                  } ${interactive ? 'cursor-pointer hover:border-outline-variant/40' : 'cursor-default opacity-70'}`}
                >
                  <span
                    className={`mt-0.5 text-xs font-semibold ${selected ? 'text-primary' : 'text-on-surface-variant/70'}`}
                  >
                    {selected ? <Check size={14} /> : '○'}
                  </span>
                  <span className="min-w-0 flex-1 font-medium text-on-surface">{option.label}</span>
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
                    ? 'border-primary/50 bg-primary/10 text-on-surface'
                    : 'border-outline-variant/15 bg-surface-container-high text-on-surface-variant'
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
          className="w-full rounded-xl border border-outline-variant/15 bg-surface-container-high px-3 py-2 text-sm text-on-surface focus:border-primary/50 focus:outline-none disabled:opacity-70"
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
