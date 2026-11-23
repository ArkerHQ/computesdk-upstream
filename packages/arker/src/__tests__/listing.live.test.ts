import { afterEach, describe, expect, it, vi } from 'vitest';
import { Arker } from '@arker-ai/sdk';
import { arker } from '../index';

describe.skipIf(!process.env.ARKER_API_KEY)('Arker paginated inventory (live)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('finds all owned sandboxes through real single-entry backend pages', async () => {
    const provider = arker({ platforms: process.env.ARKER_PLATFORMS?.split(',') });
    const owned: Awaited<ReturnType<typeof provider.instances.create>>[] = [];
    try {
      for (let index = 0; index < 3; index += 1) owned.push(await provider.instances.create());
      const original = Arker.prototype.listVms;
      const list = vi.spyOn(Arker.prototype, 'listVms').mockImplementation(function (this: Arker, options) {
        return original.call(this, { ...(options ?? {}), limit: 1 });
      });
      const instances = await provider.instances.list();
      const ids = instances.map((instance) => instance.instanceId);
      for (const box of owned) expect(ids).toContain(box.instanceId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(list.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      vi.restoreAllMocks();
      const cleanup = await Promise.allSettled(owned.map((box) => box.destroy()));
      expect(cleanup.filter((result) => result.status === 'rejected')).toEqual([]);
    }
  }, 90_000);
});
