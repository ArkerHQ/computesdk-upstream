import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { arker } from '../index';

describe.skipIf(!process.env.ARKER_API_KEY)('Arker detached work (live)', () => {
  it.each([false, true])('survives foreground completion while another exec keeps it active=%s', async (active) => {
    const provider = arker({ platforms: process.env.ARKER_PLATFORMS?.split(',') });
    const box = await provider.instances.create({ templateId: 'ubuntu-full-8' });
    const path = `/tmp/detached-${randomUUID()}`;
    try {
      const launch = await box.runCommand(`rm -f ${path}; nohup setsid sh -c 'sleep 3; echo detached-ok > ${path}' >/dev/null 2>&1 </dev/null & echo launched`, { timeout: 15_000 });
      expect(launch.exitCode).toBe(0);
      expect(launch.stdout).toContain('launched');
      if (!active) await setTimeout(5_000);
      const result = await box.runCommand(`${active ? 'sleep 5; ' : ''}cat ${path}`, { timeout: 30_000 });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('detached-ok\n');
    } finally {
      await box.destroy();
    }
  }, 90_000);
});
