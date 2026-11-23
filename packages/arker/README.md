# @computesdk/arker

Arker provider for ComputeSDK — run code in [Arker](https://arker.ai) sandboxed VMs with persistent per-VM filesystems.

## Installation

```bash
npm install @computesdk/arker
```

## Setup

1. Get your Arker API key (starts with `ark_`) from [arker.ai](https://arker.ai).
2. Set the environment variable:

```bash
export ARKER_API_KEY=ark_live_your_api_key_here
```

By default the provider targets the `aws-us-east-1` region. Select another region with `region` / `ARKER_REGION`.

## Quick Start

Configure `compute` with the Arker provider and create a sandbox:

```typescript
import { compute } from 'computesdk';
import { arker } from '@computesdk/arker';

compute.setConfig({
  provider: arker({ apiKey: process.env.ARKER_API_KEY }),
});

const sandbox = await compute.instances.create();

const result = await sandbox.runCommand('node -v');
console.log(result.stdout); // v18.x

await sandbox.destroy();
```

Or call the provider factory directly when you only need one provider:

```typescript
import { arker } from '@computesdk/arker';

const sdk = arker({ apiKey: process.env.ARKER_API_KEY });
const sandbox = await sdk.sandbox.create();
```

## How sandboxes are created

Sandboxes opt into Arker's `runtime: keep_running` policy so background processes continue between commands. Compute stays allocated and billed until an explicit pause, destruction, instance deadline, or host/resource-pressure suspension. This requires an Arker server supporting runtime policy rules; deploy that server support before releasing this adapter update. Snapshot records remove the adapter's keep-running and lifetime rules, and restored instances receive their own execution policy.

`create()` forks the `ubuntu-small` golden (Node.js + Python preinstalled) by default. Choose an existing VM or boot a root filesystem from an OCI image:

- **By name** — a golden/template, via `source` in config or `templateId` in create options.
- **By id** — a specific existing VM, via `snapshotId` in create options. The `instanceId` returned by `create()` is itself a valid source, so this branches a sandbox from its current state (Arker's equivalent of a snapshot restore). If both are given, `snapshotId` wins.
- **By image** — `image: 'ubuntu:24.04'` boots an OCI image through Arker's native image fork. Images cannot be combined with `templateId` or `snapshotId`. Use native `resources` for image sizing; standard `sizeClass` bounds have not been verified for arbitrary images.

```typescript
// Default: forks the `ubuntu-small` golden
const sandbox = await sdk.sandbox.create();

// Pick a golden globally for this provider
const heavy = arker({ apiKey, source: 'ubuntu-full' });

// ...or per sandbox, by name
const other = await sdk.sandbox.create({ templateId: 'ubuntu-full' });

// Fork an existing sandbox by id — branches from its current state
const forked = await sdk.sandbox.create({ snapshotId: sandbox.instanceId });
```

## Configuration

`create({ timeout })` sets the instance lifetime in milliseconds using an Arker
scheduled-delete policy, including when restoring a snapshot. Positive lifetimes
are rounded up to whole seconds, up to 30 days; `0` removes an inherited adapter
deadline. Omitting `timeout` leaves inherited policies unchanged. Snapshot handles
themselves do not inherit the adapter's source-instance deadline.

### Environment Variables

```bash
export ARKER_API_KEY=ark_live_your_api_key_here
export ARKER_REGION=aws-us-east-1     # optional, this is the default
export ARKER_SOURCE=ubuntu-small      # optional default golden
```

### Configuration Options

```typescript
interface ArkerConfig {
  /** Arker API key (starts with `ark_`). Falls back to ARKER_API_KEY. */
  apiKey?: string;
  /** Region, e.g. `aws-us-east-1`. Falls back to ARKER_REGION, then the us-east-1 default. */
  region?: string;
  /** Golden source VM to fork on create(). Falls back to ARKER_SOURCE, then `ubuntu-small`. */
  source?: string;
}
```

## API Reference

### Command Execution

```typescript
// Shell command
const result = await sandbox.runCommand('echo hello');

// Run a script via heredoc
const result = await sandbox.runCommand(`python3 - <<'PY'
print("Hello from Python")
PY`);

// With environment and working directory
const result = await sandbox.runCommand('npm test', {
  cwd: '/app',
  env: { CI: '1' },
});
```

`runCommand` returns `{ stdout, stderr, exitCode, durationMs }`.

### Filesystem Operations

Filesystem operations run as shell commands in the VM and work over arbitrary paths.

```typescript
await sandbox.filesystem.writeFile('/tmp/hello.txt', 'hi');
const content = await sandbox.filesystem.readFile('/tmp/hello.txt');
await sandbox.filesystem.mkdir('/tmp/data');
const entries = await sandbox.filesystem.readdir('/tmp');
const exists = await sandbox.filesystem.exists('/tmp/hello.txt');
await sandbox.filesystem.remove('/tmp/hello.txt');
```

### Independent Volumes

Volumes use Arker's object-backed shared filesystems. Their bytes are independent of any one VM, and the same volume can be mounted by multiple VMs.

```typescript
const volume = await sdk.volume.create({ name: 'dataset' });
const sandbox = await sdk.instances.create({
  volumes: [{ volume, mountPath: '/mnt/data' }],
});
await sandbox.runCommand('echo retained > /mnt/data/value; sync');
await sandbox.destroy();

const restored = await sdk.instances.create({
  volumes: [{ volume, mountPath: '/mnt/data' }],
});
console.log((await restored.runCommand('cat /mnt/data/value')).stdout);
await restored.destroy();
await sdk.volume.delete(volume.id);
```

Runtime `attachVolume(volume, mountPath)` and `detachVolume(volume, mountPath)` are supported too. Volume references are filesystem IDs or handles returned by `sdk.volume`. Storage is elastic; `sizeBytes` does not reserve capacity. Read-only mounts are not supported and are rejected before VM creation.

### Sandbox Management

```typescript
const sandbox = await sdk.sandbox.create();
const info = await sandbox.getInfo();      // { id, provider, status, createdAt, ... }
const all = await sdk.sandbox.list();      // VMs visible to the API key
const existing = await sdk.sandbox.getById(sandbox.instanceId);
await sandbox.destroy();
```

## Features

- ✅ **Command Execution** — full shell, Node.js & Python preinstalled (`ubuntu-small`)
- ✅ **Filesystem Operations** — persistent per-VM filesystem (read/write/list/mkdir/exists/remove)
- ✅ **Fast cold start** — forking the default golden boots a sandbox in well under a second
- ✅ **Automatic retries** — the underlying `@arker-ai/sdk` retries transient failures (HTTP 429/502/503/504 and transient backend errors)

## Limitations

- **Snapshots are VM forks** — the adapter keeps a snapshot as an independent VM handle. Deleting the source sandbox does not delete that snapshot; delete it explicitly when finished.
- **Snapshot listing** — snapshots created by this adapter are immutable VM forks with durable metadata. Listing supports source filtering and limits; older snapshots without this metadata are not included.
- **Read-only volumes** — not supported; `readOnly: true` is rejected before creating a VM.
- **Public ports** — `getUrl` adds a public inbound rule without replacing other policies. Existing higher-precedence deny/authentication rules still apply. If inbound priority zero is already occupied, the adapter refuses to add a lower-precedence rule instead of bypassing it.
- **`getInfo` status** — always reports `running`; idle sandboxes resume automatically on their next command.

## Support

- [Arker](https://arker.ai)
- [Arker SDK](https://github.com/ArkerHQ/arker-sdk)
- [ComputeSDK Issues](https://github.com/computesdk/computesdk/issues)

## License

MIT
