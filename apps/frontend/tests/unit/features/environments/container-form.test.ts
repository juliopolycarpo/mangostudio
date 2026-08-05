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
  it('accepts a plain image', () => {
    expect(validateContainerForm(form())).toBeNull();
    expect(isContainerFormUsable(form())).toBe(true);
  });

  it('blocks an empty image without blaming the user for not typing yet', () => {
    expect(validateContainerForm(form({ image: '' }))?.field).toBe('image');
  });

  it.each(['--privileged', 'node:22 --rm', '-node'])('blocks the image %p', (image) => {
    expect(validateContainerForm(form({ image }))?.field).toBe('image');
  });

  it('blocks resource limits that are not limits', () => {
    expect(validateContainerForm(form({ cpus: '0' }))?.field).toBe('cpus');
    expect(validateContainerForm(form({ cpus: 'lots' }))?.field).toBe('cpus');
    expect(validateContainerForm(form({ cpus: '2000' }))?.field).toBe('cpus');
    expect(validateContainerForm(form({ memoryMib: '32' }))?.field).toBe('memoryMib');
    expect(validateContainerForm(form({ memoryMib: '1.5' }))?.field).toBe('memoryMib');
  });

  it('accepts limits that are', () => {
    expect(validateContainerForm(form({ cpus: '1.5', memoryMib: '2048' }))).toBeNull();
  });

  it('blocks a half-written mount without a policy sentence', () => {
    const error = validateContainerForm(
      form({ mounts: [{ hostPath: '/home/j', containerPath: '', readonly: false }] })
    );

    expect(error?.field).toBe('mounts');
    expect(error?.refusal).toBeUndefined();
  });

  it('carries the shared refusal for a mount that would break out', () => {
    const error = validateContainerForm(
      form({
        mounts: [
          {
            hostPath: '/var/run/docker.sock',
            containerPath: '/var/run/docker.sock',
            readonly: false,
          },
        ],
      })
    );

    expect(error?.field).toBe('mounts');
    // The browser must reach the same conclusion as the connector, and say why.
    expect(error?.refusal?.code).toBe('engine-control');
  });

  it('blocks a relative host path the same way the connector does', () => {
    expect(
      validateContainerForm(
        form({ mounts: [{ hostPath: 'project', containerPath: '/work', readonly: false }] })
      )?.refusal?.code
    ).toBe('not-absolute');
  });
});
