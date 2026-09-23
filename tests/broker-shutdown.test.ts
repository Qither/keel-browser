import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/broker.js';
import { brokerStatus } from '../src/client.js';
import { KeelError, type RouterEngine } from '../src/contracts.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(shutdown: RouterEngine['shutdown'], brokenAudit = false) {
  const home = await mkdtemp(join(tmpdir(), 'keel-broker-shutdown-'));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  if (brokenAudit) await mkdir(join(home, 'audit.jsonl'));
  const engine: RouterEngine = { call: vi.fn(async () => ({})), sweep: vi.fn(async () => {}), shutdown };
  const onStopped = vi.fn();
  const handle = await startServer({ home, engine, onStopped });
  cleanups.push(() => handle.stop());
  const request = (method: '$ping' | '$stop') => fetch(`http://127.0.0.1:${handle.port}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}`, connection: 'close' },
    body: JSON.stringify({ method }),
    signal: AbortSignal.timeout(2_000),
  });
  return { home, engine, handle, onStopped, request };
}

describe('broker shutdown failure recovery', () => {
  it('preserves its state, lock, and listener after cleanup fails, then completes an authenticated retry', async () => {
    const shutdown = vi.fn<RouterEngine['shutdown']>()
      .mockRejectedValueOnce(new KeelError('CLOSE_FAILED', 'Some session tabs could not be closed. Retry closing this session.'))
      .mockResolvedValue(undefined);
    const f = await fixture(shutdown);
    const originalState = await readFile(join(f.home, 'broker.json'), 'utf8');
    const originalLock = await readFile(join(f.home, 'broker.lock'), 'utf8');

    const failure = await f.request('$stop');
    expect(failure.status).toBe(400);
    expect(await failure.json()).toMatchObject({ ok: false, error: { code: 'CLOSE_FAILED' } });
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(f.onStopped).not.toHaveBeenCalled();
    expect(await readFile(join(f.home, 'broker.json'), 'utf8')).toBe(originalState);
    expect(await readFile(join(f.home, 'broker.lock'), 'utf8')).toBe(originalLock);

    const ping = await f.request('$ping');
    expect(ping.status).toBe(200);
    expect(await ping.json()).toMatchObject({ ok: true, result: { running: true, instanceId: f.handle.instanceId } });
    await expect(startServer({ home: f.home, engine: f.engine })).rejects.toMatchObject({ code: 'BROKER_BUSY' });

    const retry = await f.request('$stop');
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ ok: true, result: { stopped: true } });
    expect(shutdown).toHaveBeenCalledTimes(2);
    expect(f.onStopped).toHaveBeenCalledTimes(1);
    await expect(readFile(join(f.home, 'broker.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(f.home, 'broker.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await brokerStatus(f.home)).toEqual({ running: false });
  });

  it('finishes stopping even when writing the audit record fails', async () => {
    const shutdown = vi.fn<RouterEngine['shutdown']>().mockResolvedValue(undefined);
    const f = await fixture(shutdown, true);

    const response = await f.request('$stop');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, result: { stopped: true } });
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(f.onStopped).toHaveBeenCalledTimes(1);
    await expect(readFile(join(f.home, 'broker.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(f.home, 'broker.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await brokerStatus(f.home)).toEqual({ running: false });
    await expect(f.request('$ping')).rejects.toThrow();
    await f.handle.stop();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
