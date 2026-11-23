import { afterEach, describe, expect, it, vi } from 'vitest';
import { Arker, VM } from '@arker-ai/sdk';
import { arker } from '../index';

const config = { apiKey: 'ark_test' };
const createdAt = '2026-01-01T00:00:00Z';

function source() {
  const update = vi.fn(async (..._args: unknown[]) => ({ immutable: true }));
  const remove = vi.fn(async () => ({}));
  const child = { id: 'snapshot-one', created_at: createdAt, baseUrl: 'https://example.invalid/api', _client: { _request: update }, delete: remove };
  const fork = vi.fn(async (options) => ({ ...child, ...options }));
  const get = vi.spyOn(Arker.prototype, 'getVm').mockResolvedValue({ id: 'source-alias', vm_id: 'vm-canonical', baseUrl: 'https://source-region.invalid/api' } as unknown as VM);
  vi.spyOn(VM.prototype, 'fork').mockImplementation(fork);
  return { fork, update, remove, get };
}

describe('Arker durable snapshot inventory', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('uses the canonical wire ID in a real SDK fork when the source is addressed by name', async () => {
    const request = vi.spyOn(Arker.prototype, '_request').mockImplementation(async (method, path, body) => {
      if (method === 'GET' && path === '/v1/vms/source-alias') {
        return { vm_id: 'vm-canonical', created_at: createdAt } as never;
      }
      if (method === 'POST' && path === '/v1/fork') {
        expect(body).toMatchObject({ source_vm_id: 'vm-canonical' });
        return { vm_id: 'snapshot-one', created_at: createdAt } as never;
      }
      if (method === 'PATCH' && path === '/v1/vms/snapshot-one') {
        expect(body).toEqual({ immutable: true });
        return { immutable: true } as never;
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    });
    const snapshot = await arker(config).snapshot!.create('source-alias');
    expect(snapshot.metadata!.sourceInstanceId).toBe('vm-canonical');
    expect(request.mock.calls.map(([method, path]) => [method, path])).toEqual([
      ['GET', '/v1/vms/source-alias'], ['POST', '/v1/fork'], ['PATCH', '/v1/vms/snapshot-one'],
    ]);
    expect(new Set(request.mock.calls.map(call => call[3])).size).toBe(1);
  });

  it('freezes only the snapshot and round-trips metadata through a fresh client after source deletion', async () => {
    const { fork, update, remove, get } = source();
    const options = { name: 'checkpoint 世界', metadata: { task: 'build', sourceInstanceId: 'caller-value' } };
    const snapshot = await arker(config).snapshot!.create('source-alias', options);
    expect(get).toHaveBeenCalledWith('source-alias');
    expect(update).toHaveBeenCalledWith('PATCH', '/v1/vms/snapshot-one', { immutable: true }, 'https://example.invalid/api');
    expect(remove).not.toHaveBeenCalled();
    const description = fork.mock.calls[0][0].description;
    get.mockRejectedValue(new Error('source was deleted'));
    const list = vi.spyOn(Arker.prototype, 'listVms').mockResolvedValue({
      vms: [{ id: snapshot.id, description, immutable: true, created_at: createdAt } as unknown as VM], nextCursor: null,
    });
    const snapshots = await arker(config).snapshot!.list({ instanceId: 'vm-canonical' });
    expect(snapshots).toEqual([snapshot]);
    expect(snapshot.metadata).toMatchObject({ name: options.name, ...options.metadata });
    expect(list).toHaveBeenCalledWith({});
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('paginates before filtering and limiting, excluding mutable records and name collisions', async () => {
    const { fork } = source();
    await arker(config).snapshot!.create('vm-canonical');
    const description = fork.mock.calls[0][0].description;
    const list = vi.spyOn(Arker.prototype, 'listVms')
      .mockResolvedValueOnce({ vms: [
        { id: 'ordinary', name: 'computesdk-snapshot-collision', immutable: true },
        { id: 'mutable', description, immutable: false },
        { id: 'invalid', description: '{bad json', immutable: true },
      ] as unknown as VM[], nextCursor: 'next' })
      .mockResolvedValueOnce({ vms: [
        { id: 'valid', description, immutable: true, created_at: createdAt },
      ] as unknown as VM[], nextCursor: null });
    const snapshots = await arker(config).snapshot!.list({ sandboxId: 'vm-canonical', limit: 1 });
    expect(snapshots.map(s => s.id)).toEqual(['valid']);
    expect(list.mock.calls).toEqual([[{}], [{ cursor: 'next' }]]);
  });

  it('checks candidate immutability when the listing omits it', async () => {
    const { fork, get } = source();
    await arker(config).snapshot!.create('vm-canonical');
    const description = fork.mock.calls[0][0].description;
    const refresh = vi.fn(async () => ({ id: 'candidate', description, immutable: true, created_at: createdAt }));
    vi.spyOn(Arker.prototype, 'listVms').mockResolvedValue({ vms: [
      { id: 'candidate', description, created_at: createdAt, baseUrl: 'https://another-region.invalid/api', refresh },
    ] as unknown as VM[], nextCursor: null });
    expect((await arker(config).snapshot!.list()).map(s => s.id)).toEqual(['candidate']);
    expect(refresh).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('does not return partial inventory after a later-page failure', async () => {
    const error = new Error('next page failed');
    vi.spyOn(Arker.prototype, 'listVms')
      .mockResolvedValueOnce({ vms: [], nextCursor: 'next' })
      .mockRejectedValueOnce(error);
    await expect(arker(config).snapshot!.list()).rejects.toBe(error);
  });

  it('deletes only the newly forked child when freezing fails', async () => {
    const { update, remove } = source();
    const error = new Error('freeze failed');
    update.mockRejectedValue(error);
    await expect(arker(config).snapshot!.create('vm-canonical')).rejects.toBe(error);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('surfaces both freeze and cleanup failures', async () => {
    const { update, remove } = source();
    const freeze = new Error('freeze failed'), cleanup = new Error('delete failed');
    update.mockRejectedValue(freeze);
    remove.mockRejectedValue(cleanup);
    await expect(arker(config).snapshot!.create('vm-canonical')).rejects.toMatchObject({ errors: [freeze, cleanup] });
  });

  it('does not trust a successful patch that did not freeze the child', async () => {
    const { update, remove } = source();
    update.mockResolvedValue({ immutable: false });
    await expect(arker(config).snapshot!.create('vm-canonical')).rejects.toThrow('did not freeze');
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized durable metadata before forking', async () => {
    const { fork } = source();
    await expect(arker(config).snapshot!.create('vm-canonical', { metadata: { payload: 'x'.repeat(1024) } })).rejects.toThrow('1024');
    expect(fork).not.toHaveBeenCalled();
  });

  it('uses Unicode characters rather than UTF-16 units for the metadata bound', async () => {
    const { fork } = source();
    await expect(arker(config).snapshot!.create('vm-canonical', { metadata: { payload: '😀'.repeat(400) } })).resolves.toBeDefined();
    expect(fork).toHaveBeenCalledTimes(1);
  });

  it('round-trips JSON metadata accepted by the public snapshot API', async () => {
    const { fork } = source();
    const metadata = { attempt: 1, nested: { ready: true }, items: ['one', null] };
    const snapshot = await arker(config).snapshot!.create('vm-canonical', { metadata: metadata as unknown as Record<string, string> });
    const description = fork.mock.calls[0][0].description;
    vi.spyOn(Arker.prototype, 'listVms').mockResolvedValue({ vms: [
      { id: snapshot.id, description, immutable: true, created_at: createdAt, name: fork.mock.calls[0][0].name },
    ] as unknown as VM[], nextCursor: null });
    expect(await arker(config).snapshot!.list()).toEqual([snapshot]);
    expect(snapshot.metadata).toMatchObject(metadata);
  });

  it.each([undefined, NaN, Infinity, () => 1, Symbol('value')])('rejects metadata that JSON would silently alter (%s)', async value => {
    const { fork } = source();
    await expect(arker(config).snapshot!.create('vm-canonical', { metadata: { value } as unknown as Record<string, string> })).rejects.toThrow('JSON serializable');
    expect(fork).not.toHaveBeenCalled();
  });

  it('returns the persisted metadata even when the caller mutates nested input during the fork', async () => {
    const { fork } = source();
    const perform = fork.getMockImplementation()!;
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    fork.mockImplementationOnce(async options => { started(); await gate; return perform(options); });
    const metadata = { nested: { ready: true } };
    const creating = arker(config).snapshot!.create('vm-canonical', { metadata: metadata as unknown as Record<string, string> });
    await entered;
    metadata.nested.ready = false;
    release();
    const snapshot = await creating;
    expect(snapshot.metadata!.nested).toEqual({ ready: true });
    const options = fork.mock.calls[0][0];
    vi.spyOn(Arker.prototype, 'listVms').mockResolvedValue({ vms: [
      { id: snapshot.id, description: options.description, name: options.name, immutable: true, created_at: createdAt },
    ] as unknown as VM[], nextCursor: null });
    expect(await arker(config).snapshot!.list()).toEqual([snapshot]);
  });

  it('rejects metadata that serializes to a non-object before forking', async () => {
    const { fork } = source();
    const metadata = { toJSON: () => 'not-an-object' };
    await expect(arker(config).snapshot!.create('vm-canonical', { metadata: metadata as unknown as Record<string, string> })).rejects.toThrow('JSON object');
    expect(fork).not.toHaveBeenCalled();
  });
});
