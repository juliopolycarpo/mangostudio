import { afterEach, describe, expect, it, vi } from 'vitest';
import { triggerImageDownload } from '../../../src/lib/download-image';

describe('triggerImageDownload', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a download link with a provider-neutral filename and clicks it', () => {
    const click = vi.fn();
    const link = { href: '', download: '', click } as unknown as HTMLAnchorElement;
    const createElement = vi.spyOn(document, 'createElement').mockReturnValue(link);
    const appendChild = vi
      .spyOn(document.body, 'appendChild')
      .mockImplementation(((node: Node) => node) as typeof document.body.appendChild);
    const removeChild = vi
      .spyOn(document.body, 'removeChild')
      .mockImplementation(((node: Node) => node) as typeof document.body.removeChild);

    triggerImageDownload('/images/generated-1.png', 'mangostudio');

    expect(createElement).toHaveBeenCalledWith('a');
    expect(link.href).toBe('/images/generated-1.png');
    expect(link.download).toMatch(/^mangostudio-art-.*\.png$/);
    expect(appendChild).toHaveBeenCalledWith(link);
    expect(click).toHaveBeenCalledOnce();
    expect(removeChild).toHaveBeenCalledWith(link);
  });
});
