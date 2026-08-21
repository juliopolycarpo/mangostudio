import { afterEach, describe, expect, it, jest, spyOn } from 'bun:test';
import { triggerImageDownload } from '../../../src/lib/download-image';

describe('triggerImageDownload', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates a download link with a provider-neutral filename and clicks it', () => {
    const click = jest.fn();
    const link = { href: '', download: '', click } as unknown as HTMLAnchorElement;
    const createElement = spyOn(document, 'createElement').mockReturnValue(link);
    const appendChild = spyOn(document.body, 'appendChild').mockImplementation(
      ((node: Node) => node) as typeof document.body.appendChild
    );
    const removeChild = spyOn(document.body, 'removeChild').mockImplementation(
      ((node: Node) => node) as typeof document.body.removeChild
    );

    triggerImageDownload('/images/generated-1.png', 'mangostudio');

    expect(createElement).toHaveBeenCalledWith('a');
    expect(link.href).toBe('/images/generated-1.png');
    expect(link.download).toMatch(/^mangostudio-art-.*\.png$/);
    expect(appendChild).toHaveBeenCalledWith(link);
    expect(click).toHaveBeenCalledTimes(1);
    expect(removeChild).toHaveBeenCalledWith(link);
  });
});
