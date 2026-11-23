import { afterEach, describe, expect, it, vi } from 'vitest';
import { Arker, VM } from '@arker-ai/sdk';
import { arker } from '../index';

describe('Arker instance lifetime', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it.each([undefined, 'snapshot-one'])('sets a server-side deadline before a fork can run (snapshot=%s)', async (snapshotId) => {
    const fork = vi.spyOn(Arker.prototype, 'fork').mockResolvedValue({ id: 'vm-one', listRuns: async () => ({ runs: [] }) } as unknown as VM);
    await arker({ apiKey: 'ark_test' }).instances.create({ timeout: 240_001, snapshotId });
    expect(fork).toHaveBeenCalledWith(expect.objectContaining({
      policies: { rules: { 'computesdk-runtime': { type: 'runtime', action: 'keep_running' }, 'computesdk-lifetime': { type: 'schedule', after_created: 241, action: 'delete' } } },
    }));
  });

  it.each([-1, NaN, Infinity, 2_592_000_001])('rejects an invalid lifetime %s before creating a VM', async (timeout) => {
    const fork = vi.spyOn(Arker.prototype, 'fork').mockResolvedValue({ id: 'unexpected' } as VM);
    await expect(arker({ apiKey: 'ark_test' }).instances.create({ timeout })).rejects.toThrow('timeout');
    expect(fork).not.toHaveBeenCalled();
  });

  it('accepts zero as unlimited and clears an inherited adapter deadline', async () => {
    const fork = vi.spyOn(Arker.prototype, 'fork').mockResolvedValue({ id: 'vm-one', listRuns: async () => ({ runs: [] }) } as unknown as VM);
    await arker({ apiKey: 'ark_test' }).instances.create({ timeout: 0, snapshotId: 'snapshot-one' });
    expect(fork).toHaveBeenCalledWith(expect.objectContaining({
      policies: { rules: { 'computesdk-runtime': { type: 'runtime', action: 'keep_running' }, 'computesdk-lifetime': null } },
    }));
  });
});
