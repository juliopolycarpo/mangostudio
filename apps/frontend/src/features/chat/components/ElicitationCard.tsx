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
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { FIELD_CLASS } from '@/components/ui/Input';
import { SectionCard } from '@/components/ui/SectionCard';
import { messageKeys } from '@/features/chat/queries';
import { useI18n } from '@/hooks/use-i18n';
import { McpElicitationGoneError, respondMcpElicitation } from '@/services/mcp-elicitation-service';
import { ChoiceButton } from './ChoiceButton';

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
    <SectionCard
      label={title}
      action={
        <span className="terminal-chip">
          {labels.fromServer.replace('{server}', part.serverSlug)}
        </span>
      }
      className="w-full max-w-2xl gap-4 text-sm text-fg"
    >
      <p className="whitespace-pre-wrap font-medium text-fg">{part.message}</p>

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

      {interactive && error && <Callout tone="danger" title={error} />}

      {interactive && (
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={submitting}
            onClick={() => void respond({ action: 'cancel' })}
          >
            {labels.cancel}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={submitting}
            onClick={() => void respond({ action: 'decline' })}
          >
            {labels.decline}
          </Button>
          <Button
            type="button"
            disabled={!requiredFilled || submitting}
            onClick={() =>
              void respond({
                action: 'accept',
                content: buildContent(part.fields, values),
              })
            }
          >
            {labels.submit}
          </Button>
        </div>
      )}
    </SectionCard>
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
          <div className="space-y-2">
            {(field.options ?? []).map((option) => {
              const selected =
                field.kind === 'multi_enum'
                  ? Array.isArray(value) && value.includes(option.value)
                  : value === option.value;
              return (
                <ChoiceButton
                  key={option.value}
                  selected={selected}
                  disabled={!interactive}
                  marker="○"
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
                >
                  <span className="font-medium text-fg">{option.label}</span>
                </ChoiceButton>
              );
            })}
          </div>
        </>
      ) : field.kind === 'boolean' ? (
        <div className="flex gap-2">
          {[true, false].map((option) => (
            <ChoiceButton
              key={String(option)}
              selected={value === option}
              disabled={!interactive}
              onClick={() => onChange(option)}
              className="w-auto"
            >
              {option ? booleanTrue : booleanFalse}
            </ChoiceButton>
          ))}
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
          className={FIELD_CLASS}
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
