import { describe, expect, it } from 'vitest';
import { arker } from '../index';

describe.skipIf(!process.env.ARKER_API_KEY)('Arker OCI image (live)', () => {
  it('boots the requested image and retains custom image contents through a snapshot', async () => {
    const provider = arker({ platforms: process.env.ARKER_PLATFORMS?.split(',') });
    const box = await provider.instances.create({ image: 'debian:bookworm-slim' });
    let snapshot: Awaited<ReturnType<NonNullable<typeof provider.snapshot>['create']>> | undefined;
    let restored: Awaited<ReturnType<typeof provider.instances.create>> | undefined;
    try {
      const release = await box.runCommand('. /etc/os-release; printf "%s %s\\n" "$ID" "$VERSION_ID"; printf OCI_CONTENT > /root/oci-marker');
      expect(release.exitCode).toBe(0);
      expect(release.stdout).toBe('debian 12\n');
      snapshot = await provider.snapshot!.create(box.instanceId);
      restored = await provider.instances.create({ snapshotId: snapshot.id });
      expect((await restored.runCommand('cat /root/oci-marker')).stdout).toBe('OCI_CONTENT');
    } finally {
      const cleanup = await Promise.allSettled([
        box.destroy(),
        ...(restored ? [restored.destroy()] : []),
        ...(snapshot ? [provider.snapshot!.delete(snapshot.id)] : []),
      ]);
      expect(cleanup.filter((result) => result.status === 'rejected')).toEqual([]);
    }
  }, 300_000);
});
