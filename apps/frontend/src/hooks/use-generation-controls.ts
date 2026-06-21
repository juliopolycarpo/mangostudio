import type { ToolIntent } from '@mangostudio/shared/generation';
import { useCallback, useState } from 'react';

interface UseGenerationControlsParams {
  readonly handleRespond: (prompt: string, toolIntent?: ToolIntent) => Promise<void>;
  readonly stopGeneration: () => void;
}

export function useGenerationControls({
  handleRespond,
  stopGeneration,
}: UseGenerationControlsParams) {
  const [imageToolIntent, setImageToolIntent] = useState(false);

  const handleSubmit = useCallback(
    (prompt: string) => {
      const intent = imageToolIntent ? ('image_generation_requested' as const) : undefined;
      void handleRespond(prompt, intent);
      setImageToolIntent(false);
    },
    [handleRespond, imageToolIntent]
  );

  const handleStop = useCallback(() => {
    stopGeneration();
    setImageToolIntent(false);
  }, [stopGeneration]);

  return {
    imageToolIntent,
    setImageToolIntent,
    handleSubmit,
    handleStop,
  };
}
