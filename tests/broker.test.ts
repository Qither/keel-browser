import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { startServer } from '../src/broker.js';
import { BrowserClient } from '../src/client.js';
import { KeelError, type RouterEngine } from '../src/contracts.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'keel-broker-test-'));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const calls: unknown[] = [];
  const capability = randomUUID();
  const id = randomUUID();
  const engine: RouterEngine = {
    async call(request) {
      calls.push(request);
      if (request.method === 'open') return { sessionId: id, capability, status: 'active', clientId: request.clientId ?? 'codex', profileAlias: 'codex', profileId: 'fixture-codex', profileName: 'codex', tabs: [] };
      if (request.capability !== capability || request.sessionId !== id) throw new KeelError('INVALID_SESSION', 'Invalid session credentials.');
      return { sessionId: id, status: request.method === 'close' ? 'closed' : 'active' };
    }, async sweep() {}, async shutdown() {},
  };
  const handle = await startServer({ home, engine });
  cleanups.push(() => handle.stop());
  const request = (payload: unknown, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${handle.port}/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}`, ...headers }, body: JSON.stringify(payload),
  });
  return { home, calls, capability, id, handle, request };
}

describe('local authenticated broker', () => {
  it('requires authentication even for opening sessions and rejects browser origins/hosts', async () => {
    const f = await fixture();
    expect((await f.request({ method: 'open' }, { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await f.request({ method: 'open' }, { origin: 'https://example.test' })).status).toBe(403);
    const badHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: f.handle.port, path: '/rpc', method: 'POST', headers: { host: 'attacker.example', authorization: `Bearer ${f.handle.token}`, 'content-type': 'application/json' } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
      req.on('error', reject); req.end(JSON.stringify({ method: 'open' }));
    });
    expect(badHostStatus).toBe(403);
    expect(f.calls).toHaveLength(0);
  });
  it('rejects unsupported requests before reaching the engine', async () => {
    const f = await fixture();
    for (const payload of [{ method: 'evaluate' }, { method: 'open', endpoint: 'secret' }, { method: 'open', params: [] }]) {
      expect((await f.request(payload)).status).toBe(400);
    }
    expect(f.calls).toHaveLength(0);
  });
  it('keeps capabilities inside each transient client and prevents cross-client sessions', async () => {
    const f = await fixture();
    const first = new BrowserClient({ home: f.home });
    const second = new BrowserClient({ home: f.home });
    const result = await first.call('open') as { sessionId: string };
    expect(JSON.stringify(result)).not.toContain(f.capability);
    await expect(first.call('status', { sessionId: result.sessionId })).resolves.toMatchObject({ status: 'active' });
    await expect(second.call('status', { sessionId: result.sessionId })).rejects.toMatchObject({ code: 'SESSION_NOT_OWNED' });
    await first.closeAll();
  });
  it('preserves CLI credentials across separate invocations and removes them after close', async () => {
    const f = await fixture();
    const first = new BrowserClient({ home: f.home, persistent: true });
    await first.call('open');
    const second = new BrowserClient({ home: f.home, persistent: true });
    await expect(second.call('status', { sessionId: f.id })).resolves.toMatchObject({ status: 'active' });
    await second.call('close', { sessionId: f.id });
    await expect(readFile(join(f.home, 'cli-sessions', 'codex', `${f.id}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('binds the startup client in RPC and namespaces persistent credentials between clients', async () => {
    const f = await fixture();
    const cli = new BrowserClient({ home: f.home, persistent: true, clientId: 'claude-cli' });
    const desktop = new BrowserClient({ home: f.home, persistent: true, clientId: 'claude-desktop' });
    await cli.call('open');
    expect(f.calls[0]).toMatchObject({ method: 'open', clientId: 'claude-cli' });
    await expect(readFile(join(f.home, 'cli-sessions', 'claude-cli', `${f.id}.json`), 'utf8')).resolves.toContain('claude-cli');
    await expect(desktop.call('status', { sessionId: f.id })).rejects.toMatchObject({ code: 'SESSION_NOT_OWNED' });
    await cli.call('close', { sessionId: f.id });
    expect(f.calls.at(-1)).toMatchObject({ method: 'close', clientId: 'claude-cli' });
  });
  it('invalidates credentials on broker restart and does not replay a call', async () => {
    const f = await fixture();
    const client = new BrowserClient({ home: f.home, persistent: true });
    await client.call('open');
    await f.handle.stop();
    await expect(client.call('click', { sessionId: f.id, tabId: 'tab', ref: 'ref' })).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(f.calls).toHaveLength(1);
  });
  it('records accepted and refused calls without input, credentials or content', async () => {
    const f = await fixture();
    await f.request({ method: 'fill', sessionId: f.id, capability: f.capability, params: { tabId: 'tab', text: 'input-secret' } });
    await f.request({ method: 'open' }, { authorization: 'Bearer denied-secret' });
    await f.handle.stop();
    const audit = await readFile(join(f.home, 'audit.jsonl'), 'utf8');
    expect(audit).toContain('UNAUTHORIZED');
    expect(audit).toContain('fill');
    for (const secret of ['input-secret', 'denied-secret', f.capability, f.handle.token]) expect(audit).not.toContain(secret);
  });
  it('refuses a second broker for the same state directory', async () => {
    const f = await fixture();
    await expect(startServer({ home: f.home })).rejects.toMatchObject({ code: 'BROKER_BUSY' });
  });
});
