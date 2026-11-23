/**
 * Arker Provider - Factory-based Implementation
 *
 * Arker (https://arker.ai) runs sandboxed VMs with persistent per-VM
 * filesystems.
 */

import { randomUUID } from 'node:crypto';
import { Arker, ArkerError, VM } from '@arker-ai/sdk';
import { defineProvider, escapeShellArg, InstanceSizeError, isUnifiedVolumeMounts, resolveVolumeRef } from '@computesdk/provider';

import type { Filesystem, Mount, PatchVmRequest, PolicyEntry, ResourcesInput, RunOptions, SyncWriteResponse } from '@arker-ai/sdk';
import type {
  CommandResult,
  InstanceInfo,
  CreateInstanceOptions,
  CreateSnapshotOptions,
  FileEntry,
  ListSnapshotsOptions,
  ListVolumesOptions,
  RunCommandOptions,
  Volume,
} from '@computesdk/provider';

/** Provider used when none is configured. */
const DEFAULT_PROVIDER = 'aws';
/** Region used when none is configured. */
const DEFAULT_REGION = 'us-east-1';
/** Golden forked when none is requested — small Ubuntu VM with node + python. */
const DEFAULT_SOURCE = 'ubuntu-small';

/**
 * Catalog bounds of public ArkerHQ goldens (https://arker.ai/docs/vms). A fork
 * takes `resources` per create, but only within its source VM's bounds.
 */
const GOLDEN_BOUNDS: Record<string, { maxVcpus: number; minMemoryMiB: number; maxMemoryMiB: number }> = {
  'ubuntu-coding': { maxVcpus: 4, minMemoryMiB: 1024, maxMemoryMiB: 15360 },
  'ubuntu-coding-8': { maxVcpus: 8, minMemoryMiB: 2560, maxMemoryMiB: 16384 },
  'ubuntu-coding-32': { maxVcpus: 32, minMemoryMiB: 2560, maxMemoryMiB: 32768 },
  'ubuntu-full-8': { maxVcpus: 8, minMemoryMiB: 2560, maxMemoryMiB: 16384 },
};
/** Same-toolchain goldens a sized create forks from when no source is pinned, smallest first. */
const SIZED_SOURCES = ['ubuntu-coding', 'ubuntu-coding-8', 'ubuntu-coding-32'];
const fitsGolden = (name: string, vcpus: number, memoryMiB: number): boolean => {
  const b = GOLDEN_BOUNDS[name];
  return !!b && vcpus <= b.maxVcpus && memoryMiB >= b.minMemoryMiB && memoryMiB <= b.maxMemoryMiB;
};

export interface ArkerConfig {
  /** Arker API key (starts with `ark_`). Falls back to the ARKER_API_KEY environment variable. */
  apiKey?: string;
  /** Region, e.g. `us-east-1`. Falls back to ARKER_REGION, then the us-east-1 default.
   *  A combined `"<provider>-<region>"` value (e.g. `aws-us-east-1`) is still accepted. */
  region?: string;
  /** Compute provider, e.g. `aws`. Falls back to ARKER_PROVIDER, then `aws`.
   *  The SDK requires provider and region together. */
  provider?: string;
  /** Golden source VM to fork on create(). Falls back to ARKER_SOURCE, then `ubuntu-small`. */
  source?: string;
  /** Compute platforms to fork onto, e.g. `['graviton4']`. Falls back to ARKER_PLATFORMS (comma-separated). */
  platforms?: string[];
  /**
   * Keep the VM running between commands using a server-side policy (default
   * true). False removes the adapter's inherited runtime rule and lets idle
   * compute pause. Explicit pause, lifetime and host/resource-pressure
   * suspension still apply; this does not reserve host capacity.
   */
  keepAwake?: boolean;
}

const env = (key: string): string | undefined => {
  const value = typeof process !== 'undefined' ? process.env?.[key] : undefined;
  return value && value.trim() ? value.trim() : undefined;
};

/** Known compute providers, used to split a combined `<provider>-<region>` value. */
const PROVIDER_PREFIXES = ['aws', 'gcp', 'azure', 'arker'] as const;

/**
 * Split a region that still carries a provider prefix (`aws-us-east-1`) into
 * its parts. Returns `[undefined, region]` when there is no prefix.
 */
function splitPlacement(region: string): [string | undefined, string] {
  for (const p of PROVIDER_PREFIXES) {
    if (region.startsWith(`${p}-`)) return [p, region.slice(p.length + 1)];
  }
  return [undefined, region];
}

/**
 * Build an Arker SDK client. The SDK requires `provider` and `region`
 * together, so both always resolve to a value: config, then env
 * (ARKER_PROVIDER / ARKER_REGION), then the aws/us-east-1 default. A
 * combined `aws-us-east-1` region is split so older callers keep working.
 */
function makeClient(config: ArkerConfig): Arker {
  const rawRegion = config.region ?? env('ARKER_REGION') ?? DEFAULT_REGION;
  const [prefixed, region] = splitPlacement(rawRegion);
  const provider = config.provider ?? env('ARKER_PROVIDER') ?? prefixed ?? DEFAULT_PROVIDER;
  return new Arker({
    apiKey: config.apiKey ?? env('ARKER_API_KEY'),
    provider,
    region,
  });
}

/** Raw bytes per file-transfer command (a multiple of 3, ~1 MiB of base64). */
const WRITE_CHUNK_BYTES = 3 * 256 * 1024;

/** Name prefix marking VMs forked by `snapshot.create`. */
const SNAPSHOT_PREFIX = 'computesdk-snapshot-';
const SNAPSHOT_KIND = 'computesdk.arker.snapshot';
const RUNTIME_RULE = 'computesdk-runtime';

interface SnapshotRecord {
  kind: typeof SNAPSHOT_KIND;
  version: 1;
  sourceInstanceId: string;
  name: string | null;
  metadata: Record<string, unknown>;
}

type SnapshotVm = VM & { description?: string | null; immutable?: boolean };

function snapshotRecord(description: string | null | undefined): SnapshotRecord | undefined {
  if (!description) return undefined;
  let record: SnapshotRecord;
  try { record = JSON.parse(description); } catch { return undefined; }
  if (!record || record.kind !== SNAPSHOT_KIND || record.version !== 1 ||
      typeof record.sourceInstanceId !== 'string' || !record.sourceInstanceId ||
      !(record.name === null || typeof record.name === 'string') ||
      !record.metadata || typeof record.metadata !== 'object' || Array.isArray(record.metadata)) return undefined;
  return record;
}

function snapshotInfo(vm: VM, record: SnapshotRecord): ArkerSnapshot {
  return {
    id: vm.id,
    provider: 'arker',
    createdAt: vm.created_at ? new Date(vm.created_at) : new Date(),
    metadata: { name: record.name ?? vm.name, sourceInstanceId: record.sourceInstanceId, ...record.metadata },
  };
}

export interface ArkerSnapshot {
  /** ID of the forked VM; pass it as `snapshotId` to restore. */
  id: string;
  provider: 'arker';
  createdAt: Date;
  metadata?: Record<string, any>;
}

/** Id of the schedule rule `pause` writes to suspend a VM. */
const PAUSE_RULE = 'computesdk-pause';
const LIFETIME_RULE = 'computesdk-lifetime';
/** How long `pause` waits for the suspend to take effect. */
const PAUSE_TIMEOUT_MS = 60_000;

/**
 * Write (or, with `null`, remove) one policy rule by id, keeping the others.
 * The id-keyed `rules` form of `PATCH /v1/vms/{id}` postdates the SDK's
 * `PatchVmRequest` type, which still describes the deprecated list form.
 */
const patchRule = (vm: VM, id: string, rule: Record<string, unknown> | null) =>
  vm.update({ policies: { rules: { [id]: rule } } } as unknown as PatchVmRequest);

const isNotFound = (err: unknown): boolean => err instanceof ArkerError && err.status === 404;

/** True when an inbound rule already serves `port`. */
const exposesPort = (rule: PolicyEntry, port: number): boolean =>
  rule.type === 'inbound' && rule.action !== 'deny' && !!rule.match?.ports?.includes(port);

/** Single-quote a string for `sh -c`, escaping any embedded single quotes. */
const singleQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Marker of a synthetic hold inherited from an older adapter. */
const KEEP_AWAKE_MARK = ': computesdk-keep-awake';
const DEFAULT_LIFETIME_MS = 300_000;

/**
 * A fork copies its source's live runs, so a sandbox restored from a snapshot
 * inherits the hold its source had. End it: the restore keeps itself awake by
 * its own settings. Pending runs are listed before running ones, so a copy
 * that starts meanwhile is found in the second list.
 */
async function endInheritedHold(vm: VM): Promise<void> {
  const failures: unknown[] = [];
  for (const state of ['pending', 'running'] as const) {
    const inherited: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await vm.listRuns({ state, ...(cursor ? { cursor } : {}) });
      inherited.push(...page.runs.filter((r) => r.command?.startsWith(KEEP_AWAKE_MARK)).map((r) => r.run_id));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    for (const outcome of await Promise.allSettled(inherited.map((id) => cancelRun(vm, id)))) {
      if (outcome.status === 'rejected') failures.push(outcome.reason);
    }
  }
  if (failures.length > 0) throw failures[0];
}

/** Statuses Arker answers when it can't act right now but may on a retry. */
const BRIEFLY_UNAVAILABLE = new Set([429, 502, 503, 504]);
const CANCEL_ATTEMPTS = 3;
const CANCEL_RETRY_MS = 1_000;

/**
 * Cancel a run, trying again while Arker is briefly unavailable: the SDK does
 * not retry a cancel itself, and cancelling a run twice is harmless.
 */
async function cancelRun(vm: VM, runId: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await vm.cancelRun(runId);
      return;
    } catch (err) {
      if (isNotFound(err)) return;
      const retryable = err instanceof ArkerError && BRIEFLY_UNAVAILABLE.has(err.status);
      if (!retryable || attempt >= CANCEL_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, CANCEL_RETRY_MS));
    }
  }
}

/** Per VM: commands of this process in its default session, and other sessions free for a command. */
const commandSessions = new Map<string, { inDefault: number; idle: string[] }>();

/**
 * Take a session for one command. Arker runs one command at a time per
 * session, so a command that starts while another from this process is still
 * running gets a session of its own, kept for later concurrent commands,
 * instead of queueing behind it. `undefined` is the VM's default session,
 * which a VM that refuses another session falls back to.
 */
async function takeSession(vm: VM): Promise<string | undefined> {
  let sessions = commandSessions.get(vm.id);
  if (!sessions) commandSessions.set(vm.id, (sessions = { inDefault: 0, idle: [] }));
  if (sessions.inDefault === 0) {
    sessions.inDefault++;
    return undefined;
  }
  const idle = sessions.idle.pop();
  if (idle) return idle;
  try {
    return (await vm.createSession()).session_id;
  } catch {
    sessions.inDefault++;
    return undefined;
  }
}

/**
 * Give back a session from `takeSession`. A borrowed session whose run failed
 * may still be busy, so it is set aside (`reusable` false) rather than reused;
 * `runCommand` gives back one whose command timed out once Arker has ended the
 * run. None is deleted: deleting a session ends every process started in it,
 * including background ones from earlier commands.
 */
function releaseSession(vmId: string, sessionId: string | undefined, reusable: boolean): void {
  const sessions = commandSessions.get(vmId);
  if (!sessions) return;
  if (sessionId === undefined) sessions.inDefault = Math.max(0, sessions.inDefault - 1);
  else if (reusable) sessions.idle.push(sessionId);
}

/** Forget what this process tracks for a VM it destroyed. */
function forgetVm(vmId: string): void { commandSessions.delete(vmId); }

/** Reject once `ms` elapses, so a caller's timeout is a real deadline. */
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Arker command timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
    // The losing run keeps going until its server-side kill bound; swallow its
    // outcome so it cannot surface as an unhandled rejection.
    promise.catch(() => {});
  }
}

/** Ids Arker gives filesystems: `dir_` and 22 base62 characters. */
const FILESYSTEM_ID = /^dir_[0-9A-Za-z]{22}$/;
/** How long a mount may take to reach the guest. */
const MOUNT_TIMEOUT_MS = 120_000;

const toVolume = (fs: Filesystem): Volume => ({ id: fs.filesystem_id, name: fs.name, native: fs });

async function findFilesystemById(client: Arker, id: string): Promise<Filesystem | null> {
  try {
    const filesystem = await client.getFilesystem(id);
    if (filesystem.filesystem_id !== id) throw new Error('Arker returned a different filesystem id');
    return filesystem;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** A filesystem by id or name, or `null` when there is none. Names are unique within an org. */
async function findFilesystem(client: Arker, idOrName: string): Promise<Filesystem | null> {
  if (!idOrName) return null;
  if (FILESYSTEM_ID.test(idOrName)) {
    const fs = await findFilesystemById(client, idOrName);
    if (fs) return fs;
  }
  // Names are unique regardless of case, but Arker's prefix filter matches
  // case, so a name in another case is looked for in the full listing.
  const wanted = idOrName.toLowerCase();
  for (const namePrefix of [idOrName, undefined]) {
    let cursor: string | undefined;
    do {
      const page = await client.listFilesystems({ ...(namePrefix ? { namePrefix } : {}), ...(cursor ? { cursor } : {}) });
      const match = page.filesystems.find((fs) => fs.name.toLowerCase() === wanted);
      if (match) return match;
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
  }
  return null;
}

/**
 * The filesystem id behind a volume handle (its `id`) or a plain id or name.
 * Errors the adapter writes for volumes leave out the caller's names and paths:
 * ComputeSDK retries a create or attach whose error says `attached`, `mounted`
 * or `busy`, so a name or path containing one would retry a lasting failure.
 */
async function filesystemId(
  client: Arker, volume: string | Volume, { allowDeleted = false } = {},
): Promise<string> {
  const ref = resolveVolumeRef(volume);
  const id = typeof volume === 'string' ? undefined : ref.id;
  if (id && allowDeleted) return id;
  const fs = id ? await findFilesystemById(client, id) : await findFilesystem(client, ref.id ?? ref.name ?? '');
  if (!fs) throw new Error('Arker has no filesystem with the volume\'s id or name');
  return fs.filesystem_id;
}

/**
 * Mount a filesystem at `path` and wait until the guest has it. The guest
 * mounts it only while the VM runs, and Arker pauses a VM as soon as its last
 * run ends, so a run waits in the guest for the mount and keeps the VM running
 * that long; the mount's own state then says whether it took. When the wait
 * fails, a mount this call made (or one that had already failed) is removed,
 * so a retry starts afresh and a late mount cannot appear after the caller got
 * an error; a working mount the sandbox already had is kept. Two concurrent
 * attaches of one volume at one path share a mount, so one's failure can
 * remove the other's; attach a volume once per path.
 */
async function mountFilesystem(vm: VM, filesystemId: string, path: string): Promise<void> {
  // Arker answers a repeated mount (same filesystem and path) with the one it
  // has, so only a new mount, or one that had already failed, is removed.
  const before = await allMounts(vm);
  // Arker matches a mount point by its exact path, so one the VM already has
  // (a restore copies its source's, spelled as made) keeps the spelling it
  // has: the same volume there is reused, another one is Arker's conflict.
  const same =
    before.find((m) => m.filesystem_id === filesystemId && samePath(m.path, path)) ??
    before.find((m) => samePath(m.path, path));
  const { mount_id } = await vm.createMount({ filesystemId, path: same?.path ?? mountPoint(path) });
  const had = before.find((m) => m.mount_id === mount_id);
  const sessionId = await asideSession(vm);
  const failures: unknown[] = [];
  try {
    await waitUntilMounted(vm, filesystemId, mount_id, path, sessionId, had?.state === 'failed');
  } catch (err) {
    failures.push(err);
    if (!had || had.state === 'failed') {
      try { await vm.deleteMount(mount_id); } catch (cleanup) { failures.push(cleanup); }
    }
  }
  if (sessionId) {
    try { await vm.deleteSession(sessionId); } catch (cleanup) { failures.push(cleanup); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw Object.assign(new Error('Arker mount and cleanup failed'), { errors: failures });
}

/** Every mount on a VM, across pages. */
async function allMounts(vm: VM): Promise<Mount[]> {
  const mounts: Mount[] = [];
  let cursor: string | undefined;
  do {
    const page = await vm.listMounts(cursor ? { cursor } : {});
    mounts.push(...page.mounts);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return mounts;
}

async function waitUntilMounted(
  vm: VM, filesystemId: string, mountId: string, path: string, sessionId: string | undefined, retryingFailed: boolean,
): Promise<void> {
  const deadline = Date.now() + MOUNT_TIMEOUT_MS;
  for (;;) {
    const waitSecs = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
    // A key makes the wait safe for the SDK to retry when Arker is briefly unavailable.
    await vm.run(waitForMount(path, waitSecs), {
      timeout: waitSecs + 5,
      idempotencyKey: randomUUID(),
      ...(sessionId ? { session_id: sessionId } : {}),
    });
    const { mounts } = await vm.listMounts({ filesystemId });
    const mount = mounts.find((m) => m.mount_id === mountId && m.filesystem_id === filesystemId);
    if (mount?.state === 'mounted') return;
    if (!mount) throw new Error(`Arker mount ${mountId} of ${filesystemId} on VM ${vm.id} disappeared`);
    // A failed mount being tried again keeps its old `failed` record until
    // the new attempt is recorded, so for it only the deadline is final.
    if (mount.state === 'failed' && (!retryingFailed || Date.now() > deadline)) {
      throw new Error(`Arker could not mount ${filesystemId} on VM ${vm.id}: ${mount.state_detail ?? 'failed'}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`Arker mount of ${filesystemId} on VM ${vm.id} still attaching after ${MOUNT_TIMEOUT_MS}ms`);
    }
    // The guest can show the mount a moment before Arker records it.
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * A session for the adapter's own guest commands, so they wait on no caller's
 * command (a restore's default session can hold one copied from its source);
 * the caller deletes it after, since only its commands ran there. `undefined`
 * (the default session) when the VM refuses another session.
 */
const asideSession = (vm: VM): Promise<string | undefined> =>
  vm.createSession().then((s) => s.session_id, () => undefined);

/**
 * A guest command that exits once `path` is a mount point, or after `secs`;
 * in a subshell, so its `exit` ends only the subshell, not a session's shell.
 */
const waitForMount = (path: string, secs: number): string =>
  `(i=0; while [ $i -lt ${secs * 5} ]; do grep -qsF ${singleQuote(` ${mountPoint(path)} `)} /proc/mounts && exit 0; sleep 0.2; i=$((i+1)); done; exit 1)`;

/**
 * A path as the kernel shows a mount point: no empty or `.` segments, no
 * trailing slash. Symlinks are not resolved, so a mount under one (such as
 * `/var/run`) is confirmed by Arker's mount state after the wait's deadline.
 */
const mountPoint = (path: string): string => `/${path.split('/').filter((s) => s && s !== '.').join('/')}`;

/**
 * Mount paths must be absolute, not `/`, at most 256 bytes and without `..`,
 * as Arker requires, and Arker does not mount one with whitespace or a
 * backslash (it stays `attaching`); checked up front, with an error that
 * leaves the path out, since Arker's refusal quotes it.
 */
const isMountPath = (path: unknown): path is string =>
  typeof path === 'string' && path.startsWith('/') && !/[\s\\]/.test(path) &&
  !path.includes('..') && mountPoint(path) !== '/' && Buffer.byteLength(mountPoint(path)) <= 256;

const MOUNT_PATH_RULE = 'an absolute mount path other than /, of at most 256 bytes, without whitespace, backslashes or `..`';

/** Arker mounts are read-write; refuse a read-only mount rather than grant write access. */
function refuseReadOnly(mounts: { readOnly?: boolean }[]): void {
  const index = mounts.findIndex((m) => m.readOnly);
  if (index >= 0) throw new Error(`Arker cannot mount volumes[${index}] read-only: its mounts are read-write`);
}

/** Paths name the same mount point when they normalise to the same path (symlinks unresolved). */
const samePath = (a: string, b: string): boolean => mountPoint(a) === mountPoint(b);

export const arker = defineProvider<VM, ArkerConfig>({
  name: 'arker',
  // Arker sizes per fork with `resources`, bounded by the source VM. Unpinned
  // creates fork the smallest ubuntu-coding golden that holds the shape.
  sizes: (config, profile, options) => {
    // The SDK already rejects sizeClass combined with native `resources`.
    const { vcpus, memoryMiB } = profile;
    const sized = { resources: { vcpu: vcpus, memory_mib: memoryMiB } };
    if (options?.snapshotId) {
      return { status: 'unknown', reason: 'A snapshot fork keeps its source VM\'s resource bounds, which this adapter has not verified.' };
    }
    if (options?.image !== undefined) {
      return { status: 'unknown', reason: 'OCI image resource bounds have not been verified; use native resources instead of sizeClass.' };
    }
    const pinned = options?.templateId || config.source || env('ARKER_SOURCE');
    if (pinned) {
      if (GOLDEN_BOUNDS[pinned] && !fitsGolden(pinned, vcpus, memoryMiB)) {
        const b = GOLDEN_BOUNDS[pinned];
        return { status: 'unsupported', reason: `Arker golden ${pinned} forks at 1-${b.maxVcpus} vCPU / ${b.minMemoryMiB}-${b.maxMemoryMiB} MiB, not ${vcpus} vCPU / ${memoryMiB} MiB.` };
      }
      return { status: 'supported', nativeOptions: sized };
    }
    const golden = SIZED_SOURCES.find((g) => fitsGolden(g, vcpus, memoryMiB));
    if (!golden) {
      return { status: 'unsupported', reason: `No public Arker golden forks at ${vcpus} vCPU / ${memoryMiB} MiB.` };
    }
    return { status: 'supported', nativeOptions: { templateId: golden, ...sized } };
  },
  methods: {
    instances: {
      // --- Collection operations ---

      create: async (config: ArkerConfig, options?: CreateInstanceOptions) => {
        const image = options?.image;
        if (image !== undefined && (typeof image !== 'string' || !image.trim())) {
          throw new Error('Arker image must be a nonempty OCI image reference');
        }
        if (image !== undefined && (options?.snapshotId || options?.templateId)) {
          throw new Error('Arker image cannot be combined with snapshotId or templateId');
        }
        const client = makeClient(config);
        const name = options?.name ?? null;
        
        const platforms =
          config.platforms ??
          env('ARKER_PLATFORMS')?.split(',').map((p) => p.trim()).filter(Boolean);
        const resources = options?.resources as ResourcesInput | undefined;
        const source = options?.templateId || config.source || env('ARKER_SOURCE') || DEFAULT_SOURCE;
        const timeout = options?.timeout ?? DEFAULT_LIFETIME_MS;
        if (!Number.isFinite(timeout) || timeout < 0 || timeout > 2_592_000_000) {
          throw new Error('Arker instance timeout must be between 0 and 2592000000 milliseconds (30 days)');
        }
        const policies = {
          rules: {
            [RUNTIME_RULE]: config.keepAwake === false ? null : { type: 'runtime', action: 'keep_running' },
            [LIFETIME_RULE]: timeout === 0 ? null : {
              type: 'schedule' as const, after_created: Math.ceil(timeout / 1000), action: 'delete' as const,
            },
          },
        } as unknown as Parameters<Arker['fork']>[0]['policies'];
        const forkOptions = { name, ...(resources ? { resources } : {}), policies };

        // Arker has no native `volumes` shape to pass through, so anything but
        // unified `{ volume, mountPath }` entries is a mistake worth reporting.
        const requested: unknown = options?.volumes;
        const isEmpty = requested === undefined || (Array.isArray(requested) && requested.length === 0);
        if (!isEmpty && !(isUnifiedVolumeMounts(requested) && requested.every((m) => isMountPath(m.mountPath)))) {
          throw new Error(`Arker create: each \`volumes\` entry needs a \`volume\` and, as \`mountPath\`, ${MOUNT_PATH_RULE}`);
        }
        const volumes = isUnifiedVolumeMounts(requested) ? requested : [];
        refuseReadOnly(volumes);
        // Resolved before the fork, so a volume that isn't there costs no VM.
        const mounts = await Promise.all(
          volumes.map(async ({ volume, mountPath }) => ({ id: await filesystemId(client, volume), mountPath })),
        );

        let vm: VM;
        try {
          // SDK 1.x takes a single options object keyed by the wire schema
          // (`source_vm_id` / `source_vm_name` / `image`); the old
          // `fork(name, opts)` overload is gone.
          const placed = { ...forkOptions, ...(platforms?.length ? { platforms } : {}) };
          // An OCI `image` boots a rootfs Arker converts from that image. A
          // first conversion can outlast a gateway timeout; with a key, the
          // SDK's retry gets back the VM it built instead of leaving it behind.
          vm = options?.snapshotId
            ? await client.fork({ source_vm_id: options.snapshotId, ...forkOptions })
            : image !== undefined
              ? await client.fork({ image, ...placed, idempotency: true })
              : await client.fork({ source_vm_name: source, ...placed });
        } catch (err) {
          // The source VM bounds the resources a fork can take; Arker enforces them.
          if (resources && err instanceof ArkerError && (err.status === 400 || err.status === 422) &&
              /vcpu|memory|resource/i.test(err.message)) {
            throw new InstanceSizeError(
              'unsupported',
              `Arker cannot fork ${options?.snapshotId ?? options?.image ?? source} at ${JSON.stringify(resources)}: ${err.message}`,
            );
          }
          throw err;
        }

        try {
          if (image === undefined) await endInheritedHold(vm);
          for (const { id, mountPath } of mounts) await mountFilesystem(vm, id, mountPath);
        } catch (error) {
          try {
            await vm.delete();
          } catch (cleanupError) {
            throw Object.assign(new Error(`Arker create failed and VM ${vm.id} cleanup failed`), {
              cause: error, cleanupError,
            });
          }
          throw error;
        }
        return { instance: vm, instanceId: vm.id };
      },

      getById: async (config: ArkerConfig, sandboxId: string) => {
        const client = makeClient(config);
        try {
          const vm = await client.getVm(sandboxId);
          return { instance: vm, instanceId: sandboxId };
        } catch (err) {
          if (err instanceof ArkerError && err.status === 404) return null;
          throw err;
        }
      },

      list: async (config: ArkerConfig) => {
        const client = makeClient(config);
        const instances = [];
        let cursor: string | undefined;
        do {
          const page = await client.listVms(cursor ? { cursor } : {});
          instances.push(...page.vms.map((vm) => ({ instance: vm, instanceId: vm.id })));
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        return instances;
      },

      destroy: async (config: ArkerConfig, sandboxId: string) => {
        const client = makeClient(config);
        try {
          await client.vm(sandboxId).delete();
        } catch (err) {
          if (!(err instanceof ArkerError && err.status === 404)) {
            throw err;
          }
        }
        forgetVm(sandboxId);
      },

      // --- Instance operations ---

      runCommand: async (sandbox: VM, command: string, options?: RunCommandOptions): Promise<CommandResult> => {
        const startTime = Date.now();

        let fullCommand = command;
        if (options?.cwd) fullCommand = `cd ${singleQuote(options.cwd)} && { ${fullCommand}\n}`;
        if (options?.env && Object.keys(options.env).length > 0) {
          const assignments = Object.entries(options.env)
            .map(([k, v]) => {
              // `export NAME=value` can't quote the name, so reject any name
              // that isn't a valid identifier.
              if (!/^[A-Za-z_]\w*$/.test(k)) {
                throw new Error(`Arker runCommand: invalid environment variable name: ${JSON.stringify(k)}`);
              }
              return `${k}=${singleQuote(String(v))}`;
            })
            .join(' ');
          // `export` (not a `NAME=value cmd` prefix) so every part of a compound
          // command sees the variables.
          fullCommand = `export ${assignments}; ${fullCommand}`;
        }
        // Wrap in `sh -c` so any cwd/env prefix detaches with the command;
        // a bare `nohup cd … && …` would run only `cd` under nohup.
        if (options?.background) fullCommand = `nohup sh -c ${singleQuote(fullCommand)} > /dev/null 2>&1 &`;

        // Leaving `time_to_background` unset selects the SDK's synchronous
        // overload: the SDK polls the run to completion itself and resolves
        // `CompletedRunResult`, so there is nothing to poll or narrow here.
        const runOptions: Omit<RunOptions, 'time_to_background'> = {};
        // ComputeSDK's timeout is milliseconds; Arker's is seconds (rounded up so a
        // sub-second timeout stays non-zero — 0 means "no limit" to Arker).
        if (options?.timeout) runOptions.timeout = Math.max(1, Math.ceil(options.timeout / 1000));

        const session = await takeSession(sandbox);
        if (session) {
          runOptions.session_id = session;
          // Arker keeps a session's working directory and exported variables
          // between runs. Commands in turn share the default session, so a
          // `cd` carries into the next one; a command that ran alongside
          // another runs in a subshell, so the session it borrowed starts the
          // next concurrent command afresh instead of where this one left it.
          if (!options?.background) fullCommand = `(\n${fullCommand}\n)`;
        }

        const run = sandbox.run(fullCommand, runOptions);
        // The run's `timeout` is a server-side kill bound, so an over-running command
        // comes back as a completed run with a non-zero exit code rather than a
        // rejection. RunCommandOptions.timeout is documented as a deadline, so reject
        // once it passes; the kill bound above stops the command server-side.
        let result: Awaited<typeof run> | undefined;
        try {
          result = options?.timeout ? await withDeadline(run, options.timeout) : await run;
        } finally {
          // The default session is free for the next command at once: Arker
          // queues it behind a run still dying, and it keeps the shell's cwd.
          // A borrowed session whose command did not come back in time is
          // busy until Arker ends the run at its `timeout`; one whose run
          // failed is set aside.
          if (result !== undefined || session === undefined) releaseSession(sandbox.id, session, true);
          else run.then(() => releaseSession(sandbox.id, session, true), () => releaseSession(sandbox.id, session, false));
        }
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          durationMs: Date.now() - startTime,
        };
      },

      getInfo: async (sandbox: VM): Promise<InstanceInfo> => ({
        id: sandbox.id,
        provider: 'arker',
        status: 'running',
        createdAt: sandbox.created_at ? new Date(sandbox.created_at) : new Date(),
        timeout: (() => {
          const lifetime = sandbox.policies?.rules?.[LIFETIME_RULE];
          return lifetime?.type === 'schedule' ? (lifetime.after_created ?? 0) * 1000 : 0;
        })(),
      }),

      // Arker serves a guest port once an inbound policy rule allows it, at
      // `<vm>-<port>.<provider>-<region>.arker.app`. Add a public (`auth: open`)
      // rule for the port, keeping the VM's other rules, and derive the URL from
      // the hostname the policy endpoint returns.
      getUrl: async (sandbox: VM, options: { port: number; protocol?: string }): Promise<string> => {
        const { port } = options;
        const current = await sandbox.getPolicies();
        const rules = current.policies ?? [];
        let doc = current;
        if (!rules.some((rule) => exposesPort(rule, port))) {
          // The legacy list contains network rules only. Replacing it would
          // silently remove runtime and lifetime rules, so patch one named
          // rule instead. Append below existing rules so a public allow cannot
          // bypass a customer's higher-precedence deny or authentication rule.
          const vm = await sandbox.refresh();
          const priorities = Object.values(vm.policies?.rules ?? {})
            .filter((rule) => rule.type === 'inbound')
            .map((rule) => 'priority' in rule ? rule.priority : 0);
          const priority = priorities.length === 0 ? 1_000_000 : Math.min(...priorities) - 1;
          if (priority < 0) throw new Error('Arker cannot add a port below existing inbound rules: priority zero is already occupied');
          await patchRule(sandbox, `computesdk-port-${port}`, {
            type: 'inbound', priority, match: { ports: [port] }, action: 'allow', auth: 'open',
          });
          doc = await sandbox.getPolicies();
        }
        const base = doc.hostname ?? current.hostname;
        if (!base) throw new Error(`Arker did not return an inbound hostname for VM ${sandbox.id}`);
        const dot = base.indexOf('.');
        const host = `${base.slice(0, dot)}-${port}${base.slice(dot)}`;
        const protocol = options.protocol ?? 'https';
        return `${protocol}://${host}`;
      },

      getInstance: (sandbox: VM): VM => sandbox,

      // A filesystem can be mounted on any number of VMs at once, at one path
      // on each, and stays when they are destroyed. Mounting starts a paused
      // sandbox, as a command would.
      attachVolume: async (sandbox: VM, volume: string | Volume, mountPath: string): Promise<void> => {
        if (!isMountPath(mountPath)) throw new Error(`Arker attachVolume needs ${MOUNT_PATH_RULE}`);
        await mountFilesystem(sandbox, await filesystemId(sandbox._client, volume), mountPath);
      },

      // `mountPath`, when given, must be where the volume is mounted.
      detachVolume: async (sandbox: VM, volume: string | Volume, mountPath?: string): Promise<void> => {
        // A saved handle can still identify a mount after its filesystem is deleted.
        const id = await filesystemId(sandbox._client, volume, { allowDeleted: true });
        const mounts = (await allMounts(sandbox)).filter((m) =>
          m.filesystem_id === id && (mountPath === undefined || samePath(m.path, mountPath)));
        if (mounts.length === 0) throw new Error(`Arker volume ${id} has no such mount on VM ${sandbox.id}`);
        for (const mount of mounts) await sandbox.deleteMount(mount.mount_id);
      },

      // An idle Arker VM is already frozen; pause suspends a running one too
      // (in-flight runs go `pending`) with a `schedule` rule whose `at` has
      // passed, which fires at once. The rule is removed once the VM is idle so
      // it can't outlive the pause. Memory is kept: processes and in-flight
      // runs carry on when the VM next starts.
      pause: async (sandbox: VM): Promise<void> => {
        await patchRule(sandbox, PAUSE_RULE, {
          type: 'schedule',
          at: new Date(Date.now() - 1000).toISOString(),
          action: 'suspend',
        });
        try {
          const deadline = Date.now() + PAUSE_TIMEOUT_MS;
          while ((await sandbox.refresh()).state !== 'idle') {
            if (Date.now() > deadline) throw new Error(`Arker VM ${sandbox.id} did not suspend within ${PAUSE_TIMEOUT_MS}ms`);
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        } finally {
          await patchRule(sandbox, PAUSE_RULE, null);
        }
      },

      // Any run starts a suspended VM, and its pending runs resume with it.
      // The run takes a free session, so it does not wait on a command the
      // pause interrupted.
      resume: async (sandbox: VM): Promise<void> => {
        const session = await takeSession(sandbox);
        let returned = false;
        try {
          const result = await sandbox.run('true', session ? { session_id: session } : {});
          returned = true;
          if (result.exitCode !== 0) throw new Error(`Arker resume failed for VM ${sandbox.id}: exit ${result.exitCode}`);
        } finally {
          releaseSession(sandbox.id, session, returned);
        }
      },
      pauseCapabilities: { memory: true },

      // --- Filesystem: file bodies over Arker's native sync API, the rest over runCommand ---

      filesystem: {
        // Native sync read; large files whose presigned read fails fall back
        // to base64 chunks over runCommand.
        readFile: async (sandbox, path, runCommand): Promise<string> => {
          const fail = (detail: string) => new Error(`Arker readFile failed for ${path}: ${detail}`);
          let absolutePath = path;
          if (!absolutePath.startsWith('/')) {
            const cwd = await runCommand(sandbox, 'pwd -P');
            if (cwd.exitCode !== 0) throw fail(cwd.stderr || `pwd exited ${cwd.exitCode}`);
            const dir = cwd.stdout.replace(/\n$/, '');
            if (!dir.startsWith('/')) throw fail('pwd did not return an absolute working directory');
            absolutePath = `${dir}/${path}`;
          }
          try {
            return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await sandbox.sync(absolutePath));
          } catch (err) {
            if (!(err instanceof ArkerError) || err.status === 404) {
              throw fail(err instanceof Error ? err.message : String(err));
            }
          }
          const target = singleQuote(absolutePath);
          const stat = await runCommand(sandbox, `wc -c < ${target}`);
          if (stat.exitCode !== 0) throw fail(stat.stderr || `exit ${stat.exitCode}`);
          const sizeText = stat.stdout.trim();
          const size = Number(sizeText);
          if (!/^\d+$/.test(sizeText) || !Number.isSafeInteger(size)) throw fail('invalid file size');
          const chunks: Buffer[] = [];
          for (let start = 0; start < size; start += WRITE_CHUNK_BYTES) {
            const result = await runCommand(
              sandbox,
              `tail -c +${start + 1} ${target} | head -c ${WRITE_CHUNK_BYTES} | base64 | tr -d '\\n'`
            );
            if (result.exitCode !== 0) throw fail(result.stderr || `exit ${result.exitCode}`);
            const encoded = result.stdout.trim();
            const chunk = Buffer.from(encoded, 'base64');
            if (chunk.toString('base64') !== encoded) throw fail(`invalid base64 at byte ${start}`);
            if (chunk.length !== Math.min(WRITE_CHUNK_BYTES, size - start)) {
              throw fail(`incomplete read at byte ${start}`);
            }
            chunks.push(chunk);
          }
          return Buffer.concat(chunks).toString('utf8');
        },
        writeFile: async (sandbox, path, content, runCommand): Promise<void> => {
          const bytes = Buffer.from(content, 'utf8');
          try {
            let target = path;
            if (!target.startsWith('/')) {
              const cwd = await runCommand(sandbox, 'pwd -P');
              if (cwd.exitCode !== 0) throw new Error(cwd.stderr || `pwd exited ${cwd.exitCode}`);
              const dir = cwd.stdout.replace(/\n$/, '');
              if (!dir.startsWith('/')) throw new Error('pwd did not return an absolute working directory');
              target = `${dir}/${path}`;
            }
            try {
              await sandbox.sync(target, bytes);
              return;
            } catch (err) {
              if (!isNotFound(err)) throw err;
            }

            // Older regions lack /sync-stream. Use the documented chunk API,
            // not the persistent shell, whose history retains every payload.
            const uploadId = randomUUID();
            let start = 0;
            do {
              const end = Math.min(start + WRITE_CHUNK_BYTES, bytes.length);
              const response = await sandbox._client._request<SyncWriteResponse>(
                'POST', `/v1/vms/${encodeURIComponent(sandbox.id)}/sync`,
                { op: 'write', writes: [{ path: target, size: bytes.length, upload_id: uploadId, start, end, content: bytes.subarray(start, end).toString('base64') }] },
                sandbox.baseUrl,
              );
              const result = response.results?.[0];
              if (!response.ok || !result || result.error) {
                throw new Error(result?.error?.message ?? 'sync write returned no successful result');
              }
              if (end === bytes.length && (!result.complete || !result.written)) {
                throw new Error('sync write did not commit the complete file');
              }
              start = end;
            } while (start < bytes.length);
          } catch (err) {
            throw new Error(`Arker writeFile failed for ${path}: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
        mkdir: async (sandbox, path, runCommand): Promise<void> => {
          const result = await runCommand(sandbox, `mkdir -p "${escapeShellArg(path)}"`);
          if (result.exitCode !== 0) throw new Error(`Arker mkdir failed for ${path}: ${result.stderr || `exit ${result.exitCode}`}`);
        },
        readdir: async (sandbox, path, runCommand): Promise<FileEntry[]> => {
          const result = await runCommand(sandbox, `ls -la "${escapeShellArg(path)}"`);
          if (result.exitCode !== 0) throw new Error(`Arker readdir failed for ${path}: ${result.stderr || `exit ${result.exitCode}`}`);

          const entries: FileEntry[] = [];
          for (const line of result.stdout.split('\n')) {
            const parts = line.trim().split(/\s+/);
            // Skip the "total" line, malformed rows, and . / ..
            if (parts.length < 9 || !/^[-dl]/.test(parts[0])) continue;
            let name = parts.slice(8).join(' ');
            if (parts[0].startsWith('l')) name = name.split(' -> ')[0]; // symlink arrow
            if (name === '.' || name === '..') continue;
            // ls prints "Mmm dd HH:MM" for recent files (no year) and "Mmm dd YYYY" otherwise.
            const [month, day, timeOrYear] = parts.slice(5, 8);
            const dateStr = timeOrYear.includes(':')
              ? `${month} ${day} ${new Date().getFullYear()} ${timeOrYear}`
              : `${month} ${day} ${timeOrYear}`;
            const modified = new Date(dateStr);
            entries.push({
              name,
              type: parts[0].startsWith('d') ? 'directory' : 'file',
              size: Number(parts[4]) || 0,
              modified: isNaN(modified.getTime()) ? new Date(0) : modified,
            });
          }
          return entries;
        },
        exists: async (sandbox, path, runCommand): Promise<boolean> => {
          const result = await runCommand(sandbox, `test -e "${escapeShellArg(path)}"`);
          return result.exitCode === 0;
        },
        remove: async (sandbox, path, runCommand): Promise<void> => {
          const result = await runCommand(sandbox, `rm -rf "${escapeShellArg(path)}"`);
          if (result.exitCode !== 0) throw new Error(`Arker remove failed for ${path}: ${result.stderr || `exit ${result.exitCode}`}`);
        },
      },
    },

    // A snapshot is a warm fork of the VM (disk + memory). Restore by passing
    // its id as `snapshotId` to create(), which forks from it again.
    snapshot: {
      // The whole root disk (including /tmp, which is not a tmpfs) and running
      // processes; the source keeps running.
      capabilities: { scope: 'rootfs', memory: true, destroysSource: false },

      create: async (config: ArkerConfig, instanceId: string, options?: CreateSnapshotOptions): Promise<ArkerSnapshot> => {
        const client = makeClient(config);
        const source = await client.getVm(instanceId);
        if (!source.vm_id) throw new Error('Arker did not return the canonical source VM ID');
        const record: SnapshotRecord = {
          kind: SNAPSHOT_KIND, version: 1, sourceInstanceId: source.vm_id,
          name: options?.name ?? null, metadata: { ...options?.metadata },
        };
        const description = JSON.stringify(record, (_key, value) => {
          if (value === undefined || typeof value === 'function' || typeof value === 'symbol' ||
              (typeof value === 'number' && !Number.isFinite(value))) {
            throw new Error('Arker snapshot metadata must be JSON serializable');
          }
          return value;
        });
        if (Array.from(description).length > 1024) throw new Error('Arker snapshot metadata exceeds 1024 characters');
        const persisted = snapshotRecord(description);
        if (!persisted) throw new Error('Arker snapshot metadata must serialize to a JSON object');
        const vm = await new VM(client, source.vm_id, source.baseUrl).fork({
          name: `${SNAPSHOT_PREFIX}${randomUUID()}`, description,
          policies: { rules: { [LIFETIME_RULE]: null, [RUNTIME_RULE]: null } },
        });
        try {
          // SDK 1.3 drops immutable from update(); send the canonical patch.
          const frozen = await vm._client._request<{ immutable?: boolean }>(
            'PATCH', `/v1/vms/${encodeURIComponent(vm.id)}`, { immutable: true }, vm.baseUrl,
          );
          if (frozen.immutable !== true) throw new Error('Arker did not freeze the snapshot');
        } catch (error) {
          try { await vm.delete(); } catch (cleanup) {
            throw Object.assign(new Error('Snapshot freeze and cleanup failed'), { errors: [error, cleanup] });
          }
          throw error;
        }
        return snapshotInfo(vm, persisted);
      },

      list: async (config: ArkerConfig, options?: ListSnapshotsOptions): Promise<ArkerSnapshot[]> => {
        const client = makeClient(config);
        const snapshots: ArkerSnapshot[] = [];
        const sourceId = options?.instanceId ?? options?.sandboxId;
        let cursor: string | undefined;
        do {
          const page = await client.listVms(cursor ? { cursor } : {});
          for (const listed of page.vms) {
            let vm = listed as SnapshotVm;
            let record = snapshotRecord(vm.description);
            if (!record || (sourceId !== undefined && record.sourceInstanceId !== sourceId)) continue;
            if (vm.immutable === undefined) {
              vm = await vm.refresh() as SnapshotVm;
              record = snapshotRecord(vm.description);
            }
            if (!record || vm.immutable !== true || (sourceId !== undefined && record.sourceInstanceId !== sourceId)) continue;
            snapshots.push(snapshotInfo(vm, record));
          }
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        return options?.limit === undefined ? snapshots : snapshots.slice(0, options.limit);
      },

      delete: async (config: ArkerConfig, snapshotId: string): Promise<void> => {
        const client = makeClient(config);
        try {
          await client.vm(snapshotId).delete();
        } catch (err) {
          if (isNotFound(err)) return;
          throw err;
        }
      },
    },

    // A volume is an Arker filesystem: org-scoped storage, named uniquely,
    // that outlives the VMs it is mounted on.
    volume: {
      // Arker filesystems grow as they fill, so `sizeBytes` has nothing to set.
      create: async (config: ArkerConfig, options): Promise<Volume> =>
        toVolume(await makeClient(config).createFilesystem({ name: options.name })),

      get: async (config: ArkerConfig, volumeIdOrName: string): Promise<Volume | null> => {
        const fs = await findFilesystem(makeClient(config), volumeIdOrName);
        return fs && toVolume(fs);
      },

      list: async (config: ArkerConfig, options?: ListVolumesOptions): Promise<Volume[]> => {
        if (options?.limit !== undefined && options.limit <= 0) return [];
        const client = makeClient(config);
        const volumes: Volume[] = [];
        let cursor: string | undefined;
        do {
          // Arker serves at most 1000 per page.
          const left = options?.limit === undefined ? undefined : Math.min(options.limit - volumes.length, 1000);
          const page = await client.listFilesystems({ ...(cursor ? { cursor } : {}), ...(left === undefined ? {} : { limit: left }) });
          volumes.push(...page.filesystems.map(toVolume));
          cursor = page.next_cursor ?? undefined;
        } while (cursor && (options?.limit === undefined || volumes.length < options.limit));
        return options?.limit === undefined ? volumes : volumes.slice(0, options.limit);
      },

      // Arker expects a filesystem to be detached from every VM before it is deleted.
      delete: async (config: ArkerConfig, volumeIdOrName: string): Promise<void> => {
        const client = makeClient(config);
        const fs = await findFilesystem(client, volumeIdOrName);
        if (!fs) return;
        try {
          await client.deleteFilesystem(fs.filesystem_id);
        } catch (err) {
          if (!isNotFound(err)) throw err;
        }
      },
    },
  },
});

export type { VM as ArkerSandbox } from '@arker-ai/sdk';
