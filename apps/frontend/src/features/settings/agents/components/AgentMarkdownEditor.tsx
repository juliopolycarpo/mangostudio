interface AgentMarkdownEditorProps {
  readonly label: string;
  readonly markdown: string;
  readonly onChange: (markdown: string) => void;
}

export function AgentMarkdownEditor({ label, markdown, onChange }: AgentMarkdownEditorProps) {
  return (
    <label className="block space-y-2">
      <span className="text-sm font-semibold text-fg">{label}</span>
      <textarea
        value={markdown}
        onChange={(event) => onChange(event.target.value)}
        rows={12}
        className="w-full rounded-xl border border-stroke bg-control px-3 py-2 font-mono text-sm text-fg focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
      />
    </label>
  );
}
