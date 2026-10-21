/**
 * The hover bar over a generated image offers what exists: a download. It used
 * to offer "Save to gallery" (a second download in one place, nothing at all in
 * another) and "Regenerate" (no handler), and nothing in the frontend implements
 * either. The gallery fills itself when generation ends.
 */

import { describe, expect, it } from 'bun:test';
import { createMockMessage } from '@mangostudio/shared/test-utils';
import { screen } from '@testing-library/react';
import { AssistantImageTurn } from '../../../../src/features/chat/components/AssistantImageTurn';
import { GeneratedImagePart } from '../../../../src/features/chat/components/GeneratedImagePart';
import { render } from '../../../support/harness/render';

describe('the generated image card', () => {
  it('offers a download and nothing that does not exist', () => {
    render(
      <GeneratedImagePart
        part={{
          type: 'generated_image',
          imageId: 'image-1',
          toolCallId: 'call-1',
          status: 'completed',
          prompt: 'Paint mangoes',
          imageUrl: '/images/mangoes.png',
        }}
      />
    );

    expect(screen.getByTitle('Download')).toBeInTheDocument();
    expect(screen.queryByTitle('Save to gallery')).not.toBeInTheDocument();
  });
});

describe('the legacy image turn', () => {
  it('offers a download and neither a gallery save nor a regenerate', () => {
    render(
      <AssistantImageTurn
        msg={createMockMessage({ role: 'ai', imageUrl: '/images/mangoes.png', text: '' })}
      />
    );

    expect(screen.getByTitle('Download')).toBeInTheDocument();
    expect(screen.queryByTitle('Save to gallery')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Regenerate' })).not.toBeInTheDocument();
  });

  // A picture with no style parameters has nothing to sit beside; the second
  // grid column used to stay, empty, and push the picture into the left half.
  it('keeps the picture to one column when there is nothing beside it', () => {
    const { container } = render(
      <AssistantImageTurn
        msg={createMockMessage({ role: 'ai', imageUrl: '/images/mangoes.png', text: '' })}
      />
    );

    expect(container.querySelector('.md\\:grid-cols-2')).toBeNull();
  });

  it('sets the picture beside its style parameters when it has them', () => {
    const { container } = render(
      <AssistantImageTurn
        msg={createMockMessage({
          role: 'ai',
          imageUrl: '/images/mangoes.png',
          text: '',
          styleParams: ['watercolour'],
        })}
      />
    );

    expect(container.querySelector('.md\\:grid-cols-2')).not.toBeNull();
    expect(screen.getByText('watercolour')).toBeInTheDocument();
  });
});
