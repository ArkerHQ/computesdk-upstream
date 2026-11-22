import { afterEach, describe, expect, it, vi } from 'vitest';
import { Arker, VM } from '@arker-ai/sdk';
import { arker } from '../index';

describe('Arker instance listing', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns every page without changing cursor filters', async () => {
    const list = vi.spyOn(Arker.prototype, 'listVms')
      .mockResolvedValueOnce({ vms: [{ id: 'vm-one' } as VM], nextCursor: 'page-two' })
      .mockResolvedValueOnce({ vms: [{ id: 'vm-two' } as VM], nextCursor: null });
    const instances = await arker({ apiKey: 'ark_test' }).instances.list();
    expect(instances.map((instance) => instance.instanceId)).toEqual(['vm-one', 'vm-two']);
    expect(list.mock.calls).toEqual([[{}], [{ cursor: 'page-two' }]]);
  });

  it('does not turn a later page error into a partial successful inventory', async () => {
    const error = new Error('next page unavailable');
    vi.spyOn(Arker.prototype, 'listVms')
      .mockResolvedValueOnce({ vms: [{ id: 'vm-one' } as VM], nextCursor: 'page-two' })
      .mockRejectedValueOnce(error);
    await expect(arker({ apiKey: 'ark_test' }).instances.list()).rejects.toBe(error);
  });
});
