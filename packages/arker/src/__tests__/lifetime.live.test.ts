import { describe, expect, it, vi } from 'vitest';
import { arker } from '../index';

// Scheduled deletes run through Arker's claimed router sweep. Match the
// ComputeSDK CI capability benchmark's asynchronous deadline grace.
const DEADLINE_GRACE_MS = 120_000;

describe.skipIf(!process.env.ARKER_API_KEY)('Arker instance lifetime (live)', () => {
  it('opening a public port retains background execution and the server-side deadline', async () => {
    const provider = arker({ platforms: process.env.ARKER_PLATFORMS?.split(',') });
    const box = await provider.instances.create({ timeout: 15_000 });
    try {
      expect(await box.getUrl({ port: 8080, protocol: 'http' })).toContain('-8080.');
      const vm = await box.getInstance().refresh();
      expect(vm.policies?.rules).toMatchObject({
        'computesdk-runtime': { type: 'runtime', action: 'keep_running' },
        'computesdk-lifetime': { type: 'schedule', after_created: 15, action: 'delete' },
        'computesdk-port-8080': { type: 'inbound', action: 'allow' },
      });
      await vi.waitFor(async () => {
        expect(await provider.instances.getById(box.instanceId)).toBeNull();
      }, { timeout: DEADLINE_GRACE_MS, interval: 250 });
    } finally {
      await box.destroy();
    }
  }, 180_000);

  it('expires server-side while a snapshot remains independently restorable', async () => {
    const provider = arker({ platforms: process.env.ARKER_PLATFORMS?.split(',') });
    const box = await provider.instances.create({ timeout: 5_000 });
    let snapshot: Awaited<ReturnType<NonNullable<typeof provider.snapshot>['create']>> | undefined;
    let restored: Awaited<ReturnType<typeof provider.instances.create>> | undefined;
    try {
      snapshot = await provider.snapshot!.create(box.instanceId);
      await vi.waitFor(async () => {
        expect(await provider.instances.getById(box.instanceId)).toBeNull();
      }, { timeout: DEADLINE_GRACE_MS, interval: 250 }).catch(async (cause) => {
        const vm = await box.getInstance().refresh();
        throw Object.assign(new Error(`Deadline not honored: ${JSON.stringify({ id: vm.id, state: vm.state, policies: vm.policies })}`), { cause });
      });
      restored = await provider.instances.create({ snapshotId: snapshot.id });
      expect((await restored.runCommand('echo snapshot-survived')).stdout).toBe('snapshot-survived\n');
    } finally {
      const cleanup = await Promise.allSettled([
        box.destroy(),
        ...(restored ? [restored.destroy()] : []),
        ...(snapshot ? [provider.snapshot!.delete(snapshot.id)] : []),
      ]);
      expect(cleanup.filter((result) => result.status === 'rejected')).toEqual([]);
    }
  }, 180_000);
});
