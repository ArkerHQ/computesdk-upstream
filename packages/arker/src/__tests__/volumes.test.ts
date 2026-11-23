import { afterEach, describe, expect, it, vi } from 'vitest';
import { Arker, ArkerError, VM } from '@arker-ai/sdk';
import { arker } from '../index';

const config = { apiKey: 'ark_test', platforms: ['icelake'] };
const fsA = 'dir_aaaaaaaaaaaaaaaaaaaaaa';
const fsB = 'dir_bbbbbbbbbbbbbbbbbbbbbb';

describe('Arker volume isolation and failure propagation', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('only translates a real not-found response to null', async () => {
    const get = vi.spyOn(Arker.prototype, 'getFilesystem');
    vi.spyOn(Arker.prototype, 'listFilesystems').mockResolvedValue({ filesystems: [], next_cursor: null } as any);
    get.mockRejectedValueOnce(new ArkerError('not_found', 'missing', 404));
    expect(await arker(config).volume!.get(fsA)).toBeNull();
    const denied = new ArkerError('forbidden', 'denied', 403);
    get.mockRejectedValueOnce(denied);
    await expect(arker(config).volume!.get(fsB)).rejects.toBe(denied);
  });

  it('refuses a mismatched filesystem identity before creating a VM', async () => {
    vi.spyOn(Arker.prototype, 'getFilesystem').mockResolvedValue({ filesystem_id: fsB, name: 'other' } as any);
    const fork = vi.spyOn(Arker.prototype, 'fork');
    await expect(arker(config).instances.create({ volumes: [{ volume: { id: fsA }, mountPath: '/data' }] }))
      .rejects.toThrow('different filesystem id');
    expect(fork).not.toHaveBeenCalled();
  });

  it('exposes both a create-time mount failure and VM cleanup failure', async () => {
    vi.spyOn(Arker.prototype, 'getFilesystem').mockResolvedValue({ filesystem_id: fsA, name: 'data' } as any);
    const failure = new Error('mount failed');
    const cleanup = new Error('VM delete failed');
    const destroy = vi.fn().mockRejectedValue(cleanup);
    vi.spyOn(Arker.prototype, 'fork').mockResolvedValue({
      id: 'vm-one', listRuns: vi.fn(async () => ({ runs: [] })), listMounts: vi.fn(async () => ({ mounts: [] })),
      createMount: vi.fn().mockRejectedValue(failure), delete: destroy,
    } as unknown as VM);
    await expect(arker(config).instances.create({ volumes: [{ volume: { id: fsA }, mountPath: '/data' }] }))
      .rejects.toMatchObject({ cause: failure, cleanupError: cleanup });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it.each([undefined, '/other'])('never detaches another filesystem when mountPath=%s', async (mountPath) => {
    const remove = vi.fn().mockResolvedValue({ deleted: true });
    vi.spyOn(Arker.prototype, 'fork').mockResolvedValue({
      id: 'vm-one',
      listRuns: vi.fn(async () => ({ runs: [] })),
      listMounts: vi.fn().mockResolvedValue({ mounts: [
        { mount_id: 'mount-a', filesystem_id: fsA, path: '/data' },
        { mount_id: 'mount-b', filesystem_id: fsB, path: '/other' },
      ], next_cursor: null }),
      deleteMount: remove,
    } as unknown as VM);
    const instance = await arker(config).instances.create();
    if (mountPath === undefined) await instance.detachVolume!({ id: fsA }, mountPath);
    else await expect(instance.detachVolume!({ id: fsA }, mountPath)).rejects.toThrow('no such mount');
    expect(remove.mock.calls).toEqual(mountPath === undefined ? [['mount-a']] : []);
  });

  it('enforces the requested list limit even if the API returns a larger page', async () => {
    vi.spyOn(Arker.prototype, 'listFilesystems').mockResolvedValue({
      filesystems: [{ filesystem_id: fsA, name: 'a' }, { filesystem_id: fsB, name: 'b' }], next_cursor: null,
    } as any);
    expect(await arker(config).volume!.list!({ limit: 1 })).toHaveLength(1);
  });

  it('reads every mount page before deleting so offsets cannot shift', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({ mounts: [{ mount_id: 'a', filesystem_id: fsA, path: '/one' }], next_cursor: 'next' })
      .mockResolvedValueOnce({ mounts: [{ mount_id: 'b', filesystem_id: fsA, path: '/two' }], next_cursor: null });
    const remove = vi.fn().mockResolvedValue({ deleted: true });
    vi.spyOn(Arker.prototype, 'fork').mockResolvedValue({ id: 'vm-one', listRuns: vi.fn(async () => ({ runs: [] })), listMounts: list, deleteMount: remove } as unknown as VM);
    const instance = await arker(config).instances.create();
    await instance.detachVolume!({ id: fsA });
    expect(list).toHaveBeenLastCalledWith({ cursor: 'next' });
    expect(remove.mock.calls).toEqual([['a'], ['b']]);
    expect(list.mock.invocationCallOrder[1]).toBeLessThan(remove.mock.invocationCallOrder[0]);
  });
});
