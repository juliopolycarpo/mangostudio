interface AgentMarkdownEditorProps {
  readonly label: string;
  readonly markdown: string;
  readonly onChange: (markdown: string) => void;
}

export function AgentMarkdownEditor({ label, markdown, onChange }: AgentMarkdownEditorProps) {
  return (
    <label className="block space-y-2">
      <span className="text-sm font-semibold text-on-surface">{label}</span>
      <textarea
        value={markdown}
        onChange={(event) => onChange(event.target.value)}
        rows={12}
        className="w-full rounded-xl border border-outline-variant/20 bg-surface-container-lowest px-3 py-2 font-mono text-sm text-on-surface focus:border-primary/60 focus:outline-none focus:ring-1 focus:ring-primary/20"
      />
    </label>
  );
}
