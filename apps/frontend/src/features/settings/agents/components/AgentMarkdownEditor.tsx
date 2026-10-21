import { useId } from 'react';
import { SettingsField } from '@/components/settings/SettingsField';
import { Textarea } from '@/components/ui/Textarea';

interface AgentMarkdownEditorProps {
  readonly label: string;
  readonly markdown: string;
  readonly onChange: (markdown: string) => void;
}

export function AgentMarkdownEditor({ label, markdown, onChange }: AgentMarkdownEditorProps) {
  const id = useId();
  return (
    <SettingsField label={label} htmlFor={id}>
      <Textarea
        id={id}
        value={markdown}
        onChange={(event) => onChange(event.target.value)}
        rows={12}
        className="font-mono text-xs"
      />
    </SettingsField>
  );
}
