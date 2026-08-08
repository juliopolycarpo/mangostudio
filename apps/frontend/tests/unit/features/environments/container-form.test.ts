import { describe, expect, it } from 'vitest';
import {
  type ContainerFormFields,
  containerConfigToForm,
  containerFormToConfig,
  defaultContainerForm,
  isContainerFormUsable,
  validateContainerForm,
} from '@/features/environments/container-form';

function form(overrides: Partial<ContainerFormFields> = {}): ContainerFormFields {
  return { ...defaultContainerForm(), image: 'node:22', ...overrides };
}

describe('containerFormToConfig', () => {
  it('sends only the image when nothing else was chosen', () => {
    expect(containerFormToConfig(form())).toEqual({ image: 'node:22' });
  });

  it('omits defaults so they follow the default if it ever changes', () => {
    expect(containerFormToConfig(form({ engine: 'docker', network: true }))).toEqual({
      image: 'node:22',
    });
  });

  it('writes the choices that differ from the default', () => {
    expect(
      containerFormToConfig(
        form({ engine: 'podman', network: false, cpus: '1.5', memoryMib: '2048' })
      )
    ).toEqual({
      image: 'node:22',
      engine: 'podman',
      network: false,
      cpus: 1.5,
      memoryMib: 2048,
    });
  });

  it('trims values rather than sending what was typed', () => {
    expect(containerFormToConfig(form({ image: '  node:22  ' })).image).toBe('node:22');
  });

  it('drops blank mount rows and keeps the ones with content', () => {
    const config = containerFormToConfig(
      form({
        mounts: [
          { hostPath: '', containerPath: '', readonly: false },
          { hostPath: '/home/j/project', containerPath: '/work', readonly: true },
        ],
      })
    );

    expect(config.mounts).toEqual([
      { hostPath: '/home/j/project', containerPath: '/work', readonly: true },
    ]);
  });

  it('omits mounts entirely when every row is blank', () => {
    const config = containerFormToConfig(
      form({ mounts: [{ hostPath: '', containerPath: '', readonly: false }] })
    );

    expect(config).not.toHaveProperty('mounts');
  });
});

describe('containerConfigToForm', () => {
  it('round-trips a stored config', () => {
    const config = {
      image: 'alpine:3',
      engine: 'podman' as const,
      network: false,
      cpus: 2,
      memoryMib: 512,
      mounts: [{ hostPath: '/a', containerPath: '/b', readonly: true }],
    };

    expect(containerFormToConfig(containerConfigToForm(config))).toEqual(config);
  });

  it('reads a config that omits everything optional as the defaults', () => {
    expect(containerConfigToForm({ image: 'node:22' })).toEqual({
      image: 'node:22',
      engine: 'docker',
      network: true,
      cpus: '',
      memoryMib: '',
      mounts: [],
    });
  });

  it('survives a row the server has never seen', () => {
    expect(containerConfigToForm(undefined).image).toBe('');
    expect(containerConfigToForm({ image: 7, mounts: 'nope' }).mounts).toEqual([]);
  });
});

describe('validateContainerForm', () => {
  /** The verdict for one field, which is what most of these assert. */
  const errorFor = (fields: Parameters<typeof form>[0], field: string) =>
    validateContainerForm(form(fields)).find((entry) => entry.field === field);

  it('accepts a plain image', () => {
    expect(validateContainerForm(form())).toEqual([]);
    expect(isContainerFormUsable(form())).toBe(true);
  });

  it('blocks an empty image without blaming the user for not typing yet', () => {
    expect(errorFor({ image: '' }, 'image')).toBeDefined();
  });

  it.each(['--privileged', 'node:22 --rm', '-node'])('blocks the image %p', (image) => {
    expect(errorFor({ image }, 'image')).toBeDefined();
  });

  it('blocks resource limits that are not limits', () => {
    expect(errorFor({ cpus: '0' }, 'cpus')).toBeDefined();
    expect(errorFor({ cpus: 'lots' }, 'cpus')).toBeDefined();
    expect(errorFor({ cpus: '2000' }, 'cpus')).toBeDefined();
    expect(errorFor({ memoryMib: '32' }, 'memoryMib')).toBeDefined();
    expect(errorFor({ memoryMib: '1.5' }, 'memoryMib')).toBeDefined();
    expect(errorFor({ memoryMib: '2000000' }, 'memoryMib')).toBeDefined();
  });

  it('accepts limits that are', () => {
    expect(validateContainerForm(form({ cpus: '1.5', memoryMib: '2048' }))).toEqual([]);
  });

  it('judges every field, so an empty image cannot hide the rest', () => {
    // The dialog opens with no image; someone filling the other fields in first
    // still has to see what is wrong with them.
    const errors = validateContainerForm(
      form({
        image: '',
        cpus: '0',
        memoryMib: '32',
        mounts: [{ hostPath: '/var/run/docker.sock', containerPath: '/sock', readonly: false }],
      })
    );

    expect(errors.map((entry) => entry.field).sort()).toEqual([
      'cpus',
      'image',
      'memoryMib',
      'mounts',
    ]);
    expect(errors.find((entry) => entry.field === 'mounts')?.refusal?.code).toBe('engine-control');
  });

  it('blocks a half-written mount without a policy sentence', () => {
    const error = errorFor(
      { mounts: [{ hostPath: '/home/j', containerPath: '', readonly: false }] },
      'mounts'
    );

    expect(error?.refusal).toBeUndefined();
    expect(error?.mountIssue).toBe('incomplete');
  });

  it.each(['/my work', '/work:ro', '/work\ttab'])(
    'blocks the container path %p, which the schema rejects',
    (containerPath) => {
      const error = errorFor(
        { mounts: [{ hostPath: '/home/j', containerPath, readonly: false }] },
        'mounts'
      );

      expect(error?.mountIssue).toBe('container-path');
    }
  );

  it('blocks a mount path past the schema length bound', () => {
    const error = errorFor(
      {
        mounts: [{ hostPath: `/${'a'.repeat(1_024)}`, containerPath: '/work', readonly: false }],
      },
      'mounts'
    );

    expect(error?.mountIssue).toBe('too-long');
  });

  it('carries the shared refusal for a mount that would break out', () => {
    const error = errorFor(
      {
        mounts: [
          {
            hostPath: '/var/run/docker.sock',
            containerPath: '/var/run/docker.sock',
            readonly: false,
          },
        ],
      },
      'mounts'
    );

    // The browser must reach the same conclusion as the connector, and say why.
    expect(error?.refusal?.code).toBe('engine-control');
  });

  it('blocks a relative host path the same way the connector does', () => {
    expect(
      errorFor(
        { mounts: [{ hostPath: 'project', containerPath: '/work', readonly: false }] },
        'mounts'
      )?.refusal?.code
    ).toBe('not-absolute');
  });
});
