import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { arker } from '../index';

describe.skipIf(!process.env.ARKER_API_KEY)('Arker independent shared volumes (live)', () => {
  it('runtime detach only removes the requested volume and can attach it again', async () => {
    const provider = arker({ platforms: process.env.ARKER_PLATFORMS?.split(',') });
    const volumes: Array<Awaited<ReturnType<NonNullable<typeof provider.volume>['create']>>> = [];
    const instances: Array<Awaited<ReturnType<typeof provider.instances.create>>> = [];
    try {
      for (let index = 0; index < 2; index++) {
        volumes.push(await provider.volume!.create({ name: `detach-${randomUUID()}` }));
      }
      const instance = await provider.instances.create({ volumes: [
        { volume: volumes[0], mountPath: '/mnt/a' },
        { volume: volumes[1], mountPath: '/mnt/b' },
      ] });
      instances.push(instance);
      const write = await instance.runCommand('mountpoint -q /mnt/a && mountpoint -q /mnt/b && echo retained > /mnt/b/value && sync');
      expect(write.exitCode).toBe(0);
      await instance.detachVolume!(volumes[0]);
      const retained = await instance.runCommand('mountpoint -q /mnt/b && ! mountpoint -q /mnt/a && cat /mnt/b/value');
      expect(retained.exitCode).toBe(0);
      expect(retained.stdout).toBe('retained\n');
      await instance.attachVolume!(volumes[0], '/mnt/again');
      expect((await instance.runCommand('mountpoint -q /mnt/again')).exitCode).toBe(0);
    } finally {
      const instanceCleanup = await Promise.allSettled(instances.map((instance) => instance.destroy()));
      const volumeCleanup = await Promise.allSettled(volumes.map((volume) => provider.volume!.delete(volume.id!)));
      expect([...instanceCleanup, ...volumeCleanup].filter((result) => result.status === 'rejected')).toEqual([]);
    }
  }, 180_000);

  it('retains a 256 MiB file across concurrent mounts and source destruction', async () => {
    const provider = arker({ platforms: process.env.ARKER_PLATFORMS?.split(',') });
    const volume = await provider.volume!.create({ name: `volume-${randomUUID()}` });
    const instances = new Set<Awaited<ReturnType<typeof provider.instances.create>>>();
    const create = async () => {
      const instance = await provider.instances.create({ volumes: [{ volume, mountPath: '/mnt/data' }] });
      instances.add(instance);
      return instance;
    };
    try {
      const first = await create();
      const write = await first.runCommand('mountpoint -q /mnt/data && dd if=/dev/urandom of=/mnt/data/payload bs=1M count=256 status=none && sync && sha256sum /mnt/data/payload', { timeout: 300_000 });
      expect(write.exitCode).toBe(0);
      expect(write.stdout).toMatch(/^[a-f0-9]{64}  \/mnt\/data\/payload\n$/);
      const second = await create();
      const read = await second.runCommand('mountpoint -q /mnt/data && sha256sum /mnt/data/payload', { timeout: 300_000 });
      expect(read.exitCode).toBe(0);
      expect(read.stdout).toBe(write.stdout);
      await first.destroy();
      instances.delete(first);
      await second.destroy();
      instances.delete(second);
      const third = await create();
      const restored = await third.runCommand('mountpoint -q /mnt/data && sha256sum /mnt/data/payload', { timeout: 300_000 });
      expect(restored.exitCode).toBe(0);
      expect(restored.stdout).toBe(write.stdout);
      expect((await provider.volume!.get(volume.id!))?.id).toBe(volume.id);
    } finally {
      const cleanup = await Promise.allSettled([...instances].map((instance) => instance.destroy()));
      await provider.volume!.delete(volume.id!);
      expect(cleanup.filter((result) => result.status === 'rejected')).toEqual([]);
    }
  }, 900_000);
});
