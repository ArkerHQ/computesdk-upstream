import { Arker, ArkerError, type VM } from '@arker-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { arker } from '../index';

const HOLD = ': computesdk-keep-awake; while :; do sleep 3600 || exit; done';
type MockRun = { run_id: string; command: string; state: string };
let nextId = 0;

function mockVm(runs: MockRun[] = []) {
  const vm = {
    id: `vm-${++nextId}`,
    policies: undefined as unknown,
    createSession: vi.fn(async () => ({ session_id: 'session' })),
    run: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    listRuns: vi.fn(async (options?: { state?: string; cursor?: string }) => ({
      runs: runs.filter((run) => run.state === options?.state), next_cursor: null as string | null,
    })),
    cancelRun: vi.fn(async (_id: string) => ({ ok: true })),
    delete: vi.fn(async () => ({ deleted: true })),
    update: vi.fn(async () => ({})),
    refresh: vi.fn(async () => ({ state: 'idle' })),
  };
  const fork = vi.spyOn(Arker.prototype, 'fork').mockImplementation(async (options) => {
    vm.policies = options.policies;
    return vm as unknown as VM;
  });
  return { vm, fork };
}

describe('Arker native keep-awake and legacy restore compatibility', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('sets native execution and a five-minute delete deadline before any command', async () => {
    const { vm, fork } = mockVm();
    const box = await arker({ apiKey: 'ark_test' }).instances.create();
    expect(fork).toHaveBeenCalledWith(expect.objectContaining({ policies: { rules: {
      'computesdk-runtime': { type: 'runtime', action: 'keep_running' },
      'computesdk-lifetime': { type: 'schedule', action: 'delete', after_created: 300 },
    } } }));
    expect(vm.run).not.toHaveBeenCalled();
    expect(vm.createSession).not.toHaveBeenCalled();
    expect((await box.getInfo()).timeout).toBe(300_000);
    await box.runCommand('true');
    expect(vm.run.mock.calls).toHaveLength(1);
    expect(vm.createSession).not.toHaveBeenCalled();
  });

  it('removes an inherited adapter runtime rule when keepAwake is false without losing the lifetime', async () => {
    const { fork } = mockVm();
    await arker({ apiKey: 'ark_test', keepAwake: false }).instances.create({ snapshotId: 'snapshot', timeout: 90_000 });
    expect(fork).toHaveBeenCalledWith(expect.objectContaining({ policies: { rules: {
      'computesdk-runtime': null,
      'computesdk-lifetime': { type: 'schedule', action: 'delete', after_created: 90 },
    } } }));
  });

  it('reports persisted unlimited lifetime without creator-process bookkeeping', async () => {
    const { vm } = mockVm();
    const box = await arker({ apiKey: 'ark_test' }).instances.create({ timeout: 0 });
    expect((await box.getInfo()).timeout).toBe(0);
    expect(vm.run).not.toHaveBeenCalled();
  });

  it('cancels only legacy marked pending/running holds before returning a restore', async () => {
    const { vm } = mockVm([
      { run_id: 'pending-hold', command: HOLD, state: 'pending' },
      { run_id: 'running-hold', command: HOLD, state: 'running' },
      { run_id: 'finished-hold', command: HOLD, state: 'completed' },
      { run_id: 'customer', command: 'sleep 3600', state: 'running' },
    ]);
    await arker({ apiKey: 'ark_test', keepAwake: false }).instances.create({ snapshotId: 'snapshot' });
    expect(vm.cancelRun.mock.calls).toEqual([['pending-hold'], ['running-hold']]);
    expect(vm.run).not.toHaveBeenCalled();
  });

  it('cancels legacy holds on every run page', async () => {
    const { vm } = mockVm();
    vm.listRuns
      .mockResolvedValueOnce({ runs: [], next_cursor: 'next' })
      .mockResolvedValueOnce({ runs: [{ run_id: 'late', command: HOLD, state: 'pending' }], next_cursor: null });
    await arker({ apiKey: 'ark_test' }).instances.create({ snapshotId: 'snapshot' });
    expect(vm.listRuns).toHaveBeenNthCalledWith(2, { state: 'pending', cursor: 'next' });
    expect(vm.cancelRun).toHaveBeenCalledWith('late');
  });

  it('cleans up a failed restore and exposes both cancellation and cleanup failures', async () => {
    const { vm } = mockVm([{ run_id: 'hold', command: HOLD, state: 'running' }]);
    const cancel = new ArkerError('forbidden', 'cannot cancel', 403);
    const cleanup = new Error('delete failed');
    vm.cancelRun.mockRejectedValue(cancel);
    vm.delete.mockRejectedValue(cleanup);
    await expect(arker({ apiKey: 'ark_test' }).instances.create({ snapshotId: 'snapshot' }))
      .rejects.toMatchObject({ cause: cancel, cleanupError: cleanup });
  });

  it('retries a transient legacy cancellation but never creates another synthetic hold', async () => {
    const { vm } = mockVm([{ run_id: 'hold', command: HOLD, state: 'running' }]);
    vm.cancelRun.mockRejectedValueOnce(new ArkerError('unavailable', 'retry', 503));
    await arker({ apiKey: 'ark_test' }).instances.create({ snapshotId: 'snapshot' });
    expect(vm.cancelRun).toHaveBeenCalledTimes(2);
    expect(vm.createSession).not.toHaveBeenCalled();
    expect(vm.run).not.toHaveBeenCalled();
  });

  it('scans every VM source, including a customer VM shadowing a golden name, but not OCI images', async () => {
    const { vm } = mockVm();
    await arker({ apiKey: 'ark_test' }).instances.create({ templateId: 'my-source' });
    expect(vm.listRuns).toHaveBeenCalledTimes(2);
    vm.listRuns.mockClear();
    vm.listRuns.mockResolvedValueOnce({ runs: [{ run_id: 'shadowed-hold', command: HOLD, state: 'pending' }], next_cursor: null });
    await arker({ apiKey: 'ark_test', keepAwake: false }).instances.create({ templateId: 'ubuntu-small', timeout: 0 });
    expect(vm.cancelRun).toHaveBeenCalledWith('shadowed-hold');
    expect(vm.listRuns).toHaveBeenCalledTimes(2);
    vm.listRuns.mockClear();
    await arker({ apiKey: 'ark_test' }).instances.create({ image: 'ubuntu:24.04' });
    expect(vm.listRuns).not.toHaveBeenCalled();
  });
});
