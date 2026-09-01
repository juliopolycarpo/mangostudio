import { describe, expect, it } from 'bun:test';
import type { GeneratedImagePart as GeneratedImagePartType } from '@mangostudio/shared';
import { GeneratedImagePart } from '../../../src/features/chat/components/GeneratedImagePart';
import { render, screen } from '../../support/harness/render';

function makePart(overrides: Partial<GeneratedImagePartType> = {}): GeneratedImagePartType {
  return {
    type: 'generated_image',
    imageId: 'image-1',
    toolCallId: 'call-1',
    status: 'error',
    prompt: 'Paint mangoes',
    ...overrides,
  };
}

describe('GeneratedImagePart — error rendering', () => {
  it('renders the persisted error text verbatim when it carries no errorCode', () => {
    render(<GeneratedImagePart part={makePart({ error: 'provider exploded' })} />);

    expect(screen.getByText('provider exploded')).toBeInTheDocument();
  });

  // The persisted `error` string doubles as the tool result text a model
  // reads, so it stays in English on purpose. `errorCode` is the renderable,
  // closed reason a component switches on instead of replaying that string
  // to a non-English user. Diverging the two here isolates which one wins.
  it('prefers the localized copy over the persisted error text when errorCode names a known reason', () => {
    render(
      <GeneratedImagePart
        part={makePart({
          error: 'stale english value the render must not use',
          errorCode: 'image_generation_interrupted',
        })}
      />
    );

    expect(
      screen.queryByText('stale english value the render must not use')
    ).not.toBeInTheDocument();
    expect(
      screen.getByText('The turn was interrupted before this image was generated.')
    ).toBeInTheDocument();
  });
});
