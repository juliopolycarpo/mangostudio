import type { TextareaHTMLAttributes } from 'react';
import { FIELD_CLASS } from '@/components/ui/Input';
import { cn } from '@/lib/utils';

/**
 * A multi-line text field in the same face as `Input`: `control` fill, hairline
 * on three sides, the stronger line underneath. Vertical resize only. Mono for
 * prompts and other technical text is a call-site `className`.
 *
 * // Usage: <Textarea id="prompt" value={text} onChange={…} rows={6} />
 */
export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(FIELD_CLASS, 'h-auto min-h-24 resize-y py-2 leading-5', className)}
      {...props}
    />
  );
}
