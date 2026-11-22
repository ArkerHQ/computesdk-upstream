import { afterEach, describe, expect, it, vi } from 'vitest';
import { Arker, VM } from '@arker-ai/sdk';
import { arker } from '../index';
import type { CreateInstanceOptions } from '@computesdk/provider';

describe('Arker OCI images', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('boots the requested image instead of silently using a golden', async () => {
    const fork = vi.spyOn(Arker.prototype, 'fork').mockResolvedValue({ id: 'vm-image' } as VM);
    await arker({ apiKey: 'ark_test', platforms: ['icelake'] }).instances.create({ image: 'ubuntu:24.04', timeout: 60_000 });
    expect(fork).toHaveBeenCalledWith({
      image: 'ubuntu:24.04', name: null, platforms: ['icelake'],
      policies: { rules: {
        'computesdk-runtime': { type: 'runtime', action: 'keep_running' },
        'computesdk-lifetime': { type: 'schedule', after_created: 60, action: 'delete' },
      } },
    });
  });

  it.each([
    { image: '' }, { image: 42 }, { image: 'ubuntu:24.04', templateId: 'my-base' },
    { image: 'ubuntu:24.04', snapshotId: 'my-snapshot' },
  ])('rejects ambiguous or invalid image selection %j before creating a VM', async (options) => {
    const fork = vi.spyOn(Arker.prototype, 'fork');
    await expect(arker({ apiKey: 'ark_test' }).instances.create(options as unknown as CreateInstanceOptions)).rejects.toThrow('image');
    expect(fork).not.toHaveBeenCalled();
  });

  it('does not size an image by silently switching to a coding golden', async () => {
    const fork = vi.spyOn(Arker.prototype, 'fork');
    await expect(arker({ apiKey: 'ark_test' }).instances.create({ image: 'ubuntu:24.04', sizeClass: 'md' })).rejects.toMatchObject({ code: 'unknown' });
    expect(fork).not.toHaveBeenCalled();
  });
});
