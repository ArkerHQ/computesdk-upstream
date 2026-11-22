import { afterEach, describe, expect, it, vi } from 'vitest';
import { Arker, ArkerError, VM } from '@arker-ai/sdk';
import { arker } from '../index';

const config = { apiKey: 'ark_test', platforms: ['icelake'] };

describe('Arker shared filesystem volumes', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('creates an independent filesystem and returns its stable id', async () => {
    const create = vi.spyOn(Arker.prototype, 'createFilesystem').mockResolvedValue({ filesystem_id: 'fs-one', name: 'data' } as any);
    const volume = await arker(config).volume!.create({ name: 'data' });
    expect(create).toHaveBeenCalledWith({ name: 'data' });
    expect(volume).toMatchObject({ id: 'fs-one', name: 'data' });
  });

  it('only translates a real not-found response to null', async () => {
    const get = vi.spyOn(Arker.prototype, 'getFilesystem');
    get.mockRejectedValueOnce(new ArkerError('not_found', 'missing', 404));
    expect(await arker(config).volume!.get('fs-missing')).toBeNull();
    const denied = new ArkerError('forbidden', 'denied', 403);
    get.mockRejectedValueOnce(denied);
    await expect(arker(config).volume!.get('fs-denied')).rejects.toBe(denied);
  });

  it('mounts a filesystem during create without changing the source', async () => {
    const mount = vi.fn().mockResolvedValue({ mount_id: 'mount-one' });
    const fork = vi.spyOn(Arker.prototype, 'fork').mockResolvedValue({ id: 'vm-one', createMount: mount } as unknown as VM);
    const box = await arker(config).instances.create({ volumes: [{ volume: { id: 'fs-one' }, mountPath: '/data' }] });
    expect(box.instanceId).toBe('vm-one');
    expect(fork).toHaveBeenCalledWith({ source_vm_name: 'ubuntu-small', name: null, platforms: ['icelake'], policies: { rules: { 'computesdk-runtime': { type: 'runtime', action: 'keep_running' } } } });
    expect(mount).toHaveBeenCalledWith({ filesystemId: 'fs-one', path: '/data' });
  });

  it('deletes the new VM when a create-time mount fails', async () => {
    const error = new Error('mount failed');
    const destroy = vi.fn().mockResolvedValue({ deleted: true });
    vi.spyOn(Arker.prototype, 'fork').mockResolvedValue({ id: 'vm-one', createMount: vi.fn().mockRejectedValue(error), delete: destroy } as unknown as VM);
    await expect(arker(config).instances.create({ volumes: [{ volume: 'fs-one', mountPath: '/data' }] })).rejects.toBe(error);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('refuses read-only mounts before creating a VM', async () => {
    const fork = vi.spyOn(Arker.prototype, 'fork').mockResolvedValue({ id: 'unexpected' } as VM);
    await expect(arker(config).instances.create({ volumes: [{ volume: 'fs-one', mountPath: '/data', readOnly: true }] })).rejects.toThrow('read-only');
    expect(fork).not.toHaveBeenCalled();
  });

  it('accepts an empty mount list as an ordinary create', async () => {
    vi.spyOn(Arker.prototype, 'fork').mockResolvedValue({ id: 'vm-one' } as VM);
    expect((await arker(config).instances.create({ volumes: [] })).instanceId).toBe('vm-one');
  });

  it.each([undefined, '/other'])('never detaches another filesystem when mountPath=%s', async (mountPath) => {
    const remove = vi.fn().mockResolvedValue({ deleted: true });
    vi.spyOn(Arker.prototype, 'fork').mockResolvedValue({
      id: 'vm-one',
      listMounts: vi.fn().mockResolvedValue({ mounts: [
        { mount_id: 'mount-a', filesystem_id: 'fs-a', path: '/data' },
        { mount_id: 'mount-b', filesystem_id: 'fs-b', path: '/other' },
      ], next_cursor: null }),
      deleteMount: remove,
    } as unknown as VM);
    const instance = await arker(config).instances.create();
    await instance.detachVolume!('fs-a', mountPath);
    expect(remove.mock.calls).toEqual(mountPath === undefined ? [['mount-a']] : []);
  });

  it('enforces the requested list limit even if the API returns a larger page', async () => {
    vi.spyOn(Arker.prototype, 'listFilesystems').mockResolvedValue({
      filesystems: [{ filesystem_id: 'fs-a', name: 'a' }, { filesystem_id: 'fs-b', name: 'b' }],
      next_cursor: null,
    } as any);
    expect(await arker(config).volume!.list!({ limit: 1 })).toHaveLength(1);
  });

  it('reads every mount page before deleting so offsets cannot shift during traversal', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({ mounts: [{ mount_id: 'a', filesystem_id: 'fs-a', path: '/one' }], next_cursor: 'next' })
      .mockResolvedValueOnce({ mounts: [{ mount_id: 'b', filesystem_id: 'fs-a', path: '/two' }], next_cursor: null });
    const remove = vi.fn().mockResolvedValue({ deleted: true });
    vi.spyOn(Arker.prototype, 'fork').mockResolvedValue({ id: 'vm-one', listMounts: list, deleteMount: remove } as unknown as VM);
    const instance = await arker(config).instances.create();
    await instance.detachVolume!('fs-a');
    expect(list).toHaveBeenLastCalledWith({ filesystemId: 'fs-a', cursor: 'next' });
    expect(remove.mock.calls).toEqual([['a'], ['b']]);
    expect(list.mock.invocationCallOrder[1]).toBeLessThan(remove.mock.invocationCallOrder[0]);
  });
});
