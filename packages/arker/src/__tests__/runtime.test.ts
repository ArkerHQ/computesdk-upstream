import { afterEach, describe, expect, it, vi } from 'vitest';
import { Arker, VM } from '@arker-ai/sdk';
import { arker } from '../index';

describe('Arker background execution policy', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it.each([undefined, 'snapshot-one'])('keeps sandbox daemons running between commands (snapshot=%s)', async (snapshotId) => {
    const fork = vi.spyOn(Arker.prototype, 'fork').mockResolvedValue({ id: 'vm-one', listRuns: async () => ({ runs: [] }) } as unknown as VM);
    await arker({ apiKey: 'ark_test' }).instances.create({ snapshotId });
    expect(fork).toHaveBeenCalledWith(expect.objectContaining({
      policies: { rules: { 'computesdk-runtime': { type: 'runtime', action: 'keep_running' }, 'computesdk-lifetime': { type: 'schedule', after_created: 300, action: 'delete' } } },
    }));
  });

  it('does not leave snapshot records consuming background compute', async () => {
    const fork = vi.spyOn(VM.prototype, 'fork').mockResolvedValue({ id: 'snapshot-one', baseUrl: 'https://example.invalid/api', _client: { _request: vi.fn(async () => ({ immutable: true })) } } as unknown as VM);
    vi.spyOn(Arker.prototype, 'getVm').mockResolvedValue({ id: 'vm-one', vm_id: 'vm-one', baseUrl: 'https://example.invalid/api' } as unknown as VM);
    await arker({ apiKey: 'ark_test' }).snapshot!.create('vm-one');
    expect(fork).toHaveBeenCalledWith(expect.objectContaining({
      policies: { rules: { 'computesdk-runtime': null, 'computesdk-lifetime': null } },
    }));
  });

  it('opening a port preserves runtime, lifetime, and unrelated policy rules', async () => {
    let rules: Record<string, any> = {
      'computesdk-runtime': { type: 'runtime', action: 'keep_running' },
      'computesdk-lifetime': { type: 'schedule', after_created: 60, action: 'delete' },
      suspend: { type: 'schedule', after_last_running_start: 30, action: 'suspend' },
      existing: { type: 'inbound', priority: 100, match: { ports: [3000] }, action: 'allow', auth: 'open' },
    };
    const original = structuredClone(rules);
    const sandbox = {
      id: 'vm-one',
      listRuns: vi.fn(async () => ({ runs: [] })),
      getPolicies: vi.fn(async () => ({
        hostname: 'vm-one.example.arker.app',
        policies: Object.values(rules).filter((rule) => rule.type === 'inbound'),
      })),
      refresh: vi.fn(async () => ({ policies: { rules } })),
      update: vi.fn(async (patch) => { rules = { ...rules, ...patch.policies.rules }; }),
      setPolicies: vi.fn(async (doc) => { rules = Object.fromEntries(doc.policies.map((rule: any, index: number) => [`legacy-${index}`, rule])); return doc; }),
    };
    vi.spyOn(Arker.prototype, 'fork').mockResolvedValue(sandbox as unknown as VM);
    const instance = await arker({ apiKey: 'ark_test' }).instances.create({ timeout: 60_000 });
    expect(await instance.getUrl({ port: 8080 })).toBe('https://vm-one-8080.example.arker.app');
    expect(rules).toMatchObject(original);
    expect(rules['computesdk-port-8080']).toEqual({
      type: 'inbound', priority: 99, match: { ports: [8080] }, action: 'allow', auth: 'open',
    });
    expect(sandbox.setPolicies).not.toHaveBeenCalled();
    await instance.getUrl({ port: 8080 });
    expect(sandbox.update).toHaveBeenCalledTimes(1);
  });

  it('cannot raise a new public port above an existing priority-zero deny', async () => {
    const sandbox = {
      id: 'vm-one',
      listRuns: vi.fn(async () => ({ runs: [] })),
      getPolicies: vi.fn(async () => ({ hostname: 'vm-one.example.arker.app', policies: [{ type: 'inbound', action: 'deny' }] })),
      refresh: vi.fn(async () => ({ policies: { rules: { closed: { type: 'inbound', priority: 0, action: 'deny' } } } })),
      update: vi.fn(),
    };
    vi.spyOn(Arker.prototype, 'fork').mockResolvedValue(sandbox as unknown as VM);
    const instance = await arker({ apiKey: 'ark_test' }).instances.create();
    await expect(instance.getUrl({ port: 8080 })).rejects.toThrow('below existing inbound rules');
    expect(sandbox.update).not.toHaveBeenCalled();
  });
});
