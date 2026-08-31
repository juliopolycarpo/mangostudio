interface ErrorPartProps {
  text: string;
}

/**
 * A turn-level failure, shown verbatim so the reported cause is not reworded.
 *
 * // Usage: <ErrorPart text={part.text} />
 */
export function ErrorPart({ text }: ErrorPartProps) {
  return (
    <div className="max-w-2xl rounded-xl border border-error/20 bg-error/10 p-4 font-body text-sm text-error">
      {text}
    </div>
  );
}
