import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getHome } from './config.js';
import { KeelError, parseClientId, type ClientId, type OpenResult, type RpcRequest } from './contracts.js';
import { ensureHome, processAlive, readState, writePrivate, type BrokerState } from './state.js';

type SafeStatus = { running: boolean; pid?: number; port?: number };
type Credential = { sessionId: string; capability: string; instanceId: string; clientId: ClientId };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function rpc(state: BrokerState, request: RpcRequest): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${state.port}/rpc`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${state.token}` },
      body: JSON.stringify(request), signal: AbortSignal.timeout(request.method === '$ping' ? 2_000 : 90_000), redirect: 'error',
    });
  } catch {
    throw new KeelError('BROKER_UNAVAILABLE', 'Router connection failed; the operation was not retried.');
  }
  let envelope: { ok?: boolean; result?: unknown; error?: { code: string; message: string } };
  try { envelope = await response.json() as typeof envelope; }
  catch { throw new KeelError('BROKER_UNAVAILABLE', 'Router returned an invalid response.'); }
  if (!envelope.ok) throw new KeelError(envelope.error?.code ?? 'BROKER_ERROR', envelope.error?.message ?? 'Router operation failed.');
  return envelope.result;
}

async function liveState(home: string): Promise<BrokerState | undefined> {
  const state = await readState(home);
  if (!state || !processAlive(state.pid)) return undefined;
  try {
    const result = await rpc(state, { method: '$ping' }) as { instanceId?: string };
    return result.instanceId === state.instanceId ? state : undefined;
  } catch { return undefined; }
}

export async function brokerStatus(home = getHome()): Promise<SafeStatus> {
  const state = await liveState(home);
  return state ? { running: true, pid: state.pid, port: state.port } : { running: false };
}

export async function startBroker(home = getHome()): Promise<{ pid: number; port: number; running: true }> {
  await ensureHome(home);
  const existing = await liveState(home);
  if (existing) return { running: true, pid: existing.pid, port: existing.port };
  const stale = await readState(home);
  if (stale && processAlive(stale.pid)) throw new KeelError('BROKER_UNAVAILABLE', 'Router process exists but is unavailable. Inspect it before restarting.');
  const log = openSync(join(home, 'broker.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./broker.js', import.meta.url))], {
      detached: true, windowsHide: true, stdio: ['ignore', log, log],
      env: { ...process.env, KEEL_BROWSER_HOME: home },
    });
    // Errors are also reflected by the readiness deadline; never expose raw spawn details.
    child.on('error', () => {});
    child.unref();
  } finally { closeSync(log); }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const state = await liveState(home);
    if (state) return { running: true, pid: state.pid, port: state.port };
    await delay(100);
  }
  throw new KeelError('BROKER_START_FAILED', 'Router did not become ready. Check broker.log in its state directory.');
}

export async function stopBroker(home = getHome()): Promise<void> {
  const state = await liveState(home);
  if (!state) return;
  await rpc(state, { method: '$stop' });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const current = await readState(home);
    if (!current || current.instanceId !== state.instanceId) return;
    await delay(100);
  }
  throw new KeelError('BROKER_STOP_TIMEOUT', 'Router cleanup is still in progress.');
}

export class BrowserClient {
  private readonly home: string;
  private readonly persistent: boolean;
  private readonly clientId: ClientId;
  private readonly credentials = new Map<string, Credential>();
  constructor(options: { persistent?: boolean; home?: string; clientId?: ClientId } = {}) {
    this.home = options.home ?? getHome();
    this.persistent = options.persistent ?? false;
    this.clientId = parseClientId(options.clientId ?? process.env.KEEL_BROWSER_CLIENT ?? 'codex');
  }
  private credentialPath(id: string): string {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new KeelError('INVALID_SESSION', 'Invalid session identifier.');
    return join(this.home, 'cli-sessions', this.clientId, `${id}.json`);
  }
  private async getCredential(id: string): Promise<Credential> {
    const known = this.credentials.get(id);
    if (known) return known;
    if (this.persistent) {
      try {
        const value = JSON.parse(await readFile(this.credentialPath(id), 'utf8')) as Credential;
        if (value.sessionId === id && value.clientId === this.clientId && typeof value.capability === 'string' && typeof value.instanceId === 'string') return value;
      } catch { /* a public session ID does not grant access */ }
    }
    throw new KeelError('SESSION_NOT_OWNED', 'This client does not own the requested session.');
  }
  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (method.startsWith('$')) throw new KeelError('UNKNOWN_METHOD', 'Administrative methods are not browser tools.');
    if (method === 'open') {
      await startBroker(this.home);
      const state = await liveState(this.home);
      if (!state) throw new KeelError('BROKER_UNAVAILABLE', 'Router is unavailable.');
      const result = await rpc(state, { method, clientId: this.clientId, params: { ...params, mode: this.persistent ? 'cli' : 'mcp' } }) as OpenResult;
      const credential = { sessionId: result.sessionId, capability: result.capability, instanceId: state.instanceId, clientId: this.clientId };
      this.credentials.set(result.sessionId, credential);
      if (this.persistent) {
        try {
          await mkdir(join(this.home, 'cli-sessions', this.clientId), { recursive: true, mode: 0o700 });
          await writePrivate(this.credentialPath(result.sessionId), credential);
        } catch {
          await rpc(state, { method: 'close', clientId: this.clientId, sessionId: result.sessionId, capability: result.capability }).catch(() => {});
          this.credentials.delete(result.sessionId);
          throw new KeelError('CREDENTIAL_STORAGE_FAILED', 'Could not preserve the CLI session credential; its tabs were released.');
        }
      }
      const { capability: _private, ...publicResult } = result;
      return publicResult;
    }
    const { sessionId, ...rest } = params;
    if (typeof sessionId !== 'string') throw new KeelError('INVALID_SESSION', 'A sessionId is required.');
    const credential = await this.getCredential(sessionId);
    const state = await liveState(this.home);
    if (!state || state.instanceId !== credential.instanceId)
      throw new KeelError('SESSION_EXPIRED', 'The Router instance ended. Open a new session; old tabs are not adopted.');
    const result = await rpc(state, { method, clientId: this.clientId, sessionId, capability: credential.capability, params: rest });
    if (method === 'close') {
      this.credentials.delete(sessionId);
      if (this.persistent) await unlink(this.credentialPath(sessionId)).catch(() => {});
    }
    return result;
  }
  async heartbeat(): Promise<void> {
    await Promise.all([...this.credentials.keys()].map(sessionId => this.call('heartbeat', { sessionId }).catch(() => {})));
  }
  async closeAll(): Promise<void> {
    await Promise.all([...this.credentials.keys()].map(sessionId => this.call('close', { sessionId }).catch(() => {})));
    this.credentials.clear();
  }
}
