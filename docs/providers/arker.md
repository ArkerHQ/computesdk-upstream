---
description: >-
  Set up the Arker provider for ComputeSDK, configure your API key, and create
  sandboxed VMs to run commands with a persistent filesystem.
layout:
  width: default
  title:
    visible: true
  description:
    visible: false
  tableOfContents:
    visible: true
  outline:
    visible: true
  pagination:
    visible: true
  metadata:
    visible: true
  tags:
    visible: true
  actions:
    visible: true
---

# Arker

Arker provider for ComputeSDK — sandboxed VMs with persistent per-VM filesystems.


## Sizes and lifecycle

`sizeClass` sizes each fork via `resources.vcpu` and `resources.memory_mib`. Unpinned creates support all six tiers by selecting the smallest fitting `ubuntu-coding` golden; pinned sources retain their own bounds, and snapshot restores and `image` creates have an `unknown` standard mapping, so `sizeClass` is refused with them. See [Sandbox sizes](../reference/sizes.md).

`pause()`/`resume()` preserve memory and processes. Snapshot capabilities declare whole-rootfs and memory preservation with the source kept. Restore with `instances.create({ snapshotId })`; destroy restored children before deleting their snapshot/source.

## Installation & Setup

```bash
npm install @computesdk/arker
```

Add your Arker credentials to a `.env` file:

```bash
ARKER_API_KEY=your_arker_api_key
```

> **Note:** Arker API keys start with `ark_` — get one from [arker.ai](https://arker.ai). By default the provider targets the `aws-us-east-1` region; select another region with `ARKER_REGION`.


## Usage

```typescript
import { arker } from '@computesdk/arker';

const compute = arker({
  apiKey: process.env.ARKER_API_KEY,
});

// Create sandbox (forks the `ubuntu-small` golden by default)
const sandbox = await compute.instances.create();

// Run a command
const result = await sandbox.runCommand('echo "Hello from Arker!"');
console.log(result.stdout); // "Hello from Arker!"

// Clean up
await sandbox.destroy();
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
  /**
   * Keep each sandbox running between commands using a server-side policy.
   * Default `true`. With `false`, Arker pauses the VM whenever no command is
   * running, which also freezes background processes.
   */
  keepAwake?: boolean;
}
```

### Supported Operations

- **Sandbox lifecycle** — `create` (fork from a golden image), `getById`, `list`, `destroy`
- **Command execution** — `runCommand` with `cwd`, `env`, `timeout`, and `background` options; commands issued at the same time run concurrently. Commands in turn share one shell, so a `cd` carries into the next; while another command or a watched process runs, pass `cwd` and `env` instead. Node.js and Python are preinstalled on the default `ubuntu-small` golden
- **Filesystem** — `readFile`, `writeFile`, `mkdir`, `readdir`, `exists`, `remove` (persistent per-VM filesystem)
- **OCI images** — `create({ image: 'ubuntu:24.04' })` boots a rootfs Arker converts from a public registry image
- **Volumes** — `volume.create/get/list/delete` on Arker filesystems; mount with `create({ volumes })` or `attachVolume`, unmount with `detachVolume`. Volumes mount read-write, at absolute paths (not `/`, at most 256 bytes) without whitespace, backslashes or `..`, and can be mounted on several sandboxes at once; detach a volume everywhere before deleting it

### Notes

- **Creation is fork-only.** Direct VM creation is disabled; `create()` forks a source VM — a golden/template by name (`templateId` or `source`, `ubuntu-small` by default) or a specific VM by id (`snapshotId`) — or an OCI image (`image`). The `instanceId` returned by `create()` can be passed back as a `snapshotId` to branch from that sandbox's state; there is no separate snapshot store. `snapshotId` wins if both are given.
- **Server-enforced execution and lifetime.** The named native `keep_running` rule keeps background processes running even after the creating client exits; no synthetic hold command is started. Set `keepAwake: false` to remove the adapter's inherited runtime rule. The independent create `timeout` deletes the VM, rather than merely pausing it: five minutes by default, unlimited at `0`, up to30days. Explicit pause and host/resource-pressure suspension still apply; the policy does not reserve host capacity. This requires runtime-policy support on the server before this adapter update is released.
- **`getUrl` makes the port public.** It adds an inbound rule that serves the port with no authentication and returns its `https://` URL; for authenticated access, set the VM's network policy through the [Arker SDK](https://github.com/ArkerHQ/arker-sdk).
- **Automatic retries.** The underlying `@arker-ai/sdk` retries transient failures (HTTP 429/502/503/504) of requests that are safe to repeat: reads, requests with an idempotency key (such as image creates), and requests Arker reports it did not start.
