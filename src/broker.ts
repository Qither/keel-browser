import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { appendFile, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { getHome, loadConfig } from './config.js';
import { createEngine } from './engine.js';
import { KeelError, parseClientId, safeError, type RouterEngine, type RpcRequest } from './contracts.js';
import { ensureHome, processAlive, readState, writePrivate, type BrokerState } from './state.js';

const METHODS = new Set(['open', 'status', 'close', 'heartbeat', 'tabs', 'new_tab', 'close_tab', 'navigate', 'snapshot', 'click', 'fill', 'press', 'scroll', 'screenshot', '$ping', '$stop']);
const MAX_BODY = 128 * 1024;
const safeId = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : undefined;

async function acquireLock(home: string): Promise<() => Promise<void>> {
  const path = join(home, 'broker.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      await handle.close();
      return async () => { await unlink(path).catch(() => {}); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let owner: { pid?: number };
      try { owner = JSON.parse(await readFile(path, 'utf8')); }
      catch { throw new KeelError('BROKER_BUSY', 'Router startup is in progress or its lock needs inspection.'); }
      if (!Number.isInteger(owner.pid) || processAlive(owner.pid!))
        throw new KeelError('BROKER_BUSY', 'A Router process already owns this state directory.');
      await unlink(path).catch(() => {});
    }
  }
  throw new KeelError('BROKER_BUSY', 'Could not acquire the Router lock.');
}

async function body(request: IncomingMessage): Promise<RpcRequest> {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json')
    throw new KeelError('INVALID_REQUEST', 'Expected application/json.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > MAX_BODY) throw new KeelError('REQUEST_TOO_LARGE', 'Request exceeds the size limit.');
    chunks.push(Buffer.from(chunk));
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new KeelError('INVALID_REQUEST', 'Expected a JSON request.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new KeelError('INVALID_REQUEST', 'Expected an object.');
  const rpc = parsed as RpcRequest;
  if (!METHODS.has(rpc.method)) throw new KeelError('UNKNOWN_METHOD', 'Unsupported Router operation.');
  if (Object.keys(rpc).some(key => !['method', 'clientId', 'sessionId', 'capability', 'params'].includes(key))
    || (rpc.params !== undefined && (!rpc.params || typeof rpc.params !== 'object' || Array.isArray(rpc.params))))
    throw new KeelError('INVALID_REQUEST', 'Invalid request fields.');
  if (rpc.clientId !== undefined) parseClientId(rpc.clientId);
  return rpc;
}

export async function startServer(options: { home?: string; engine?: RouterEngine; onStopped?: () => void } = {}) {
  const home = options.home ?? getHome();
  await ensureHome(home);
  const release = await acquireLock(home);
  let engine: RouterEngine;
  try { engine = options.engine ?? createEngine(loadConfig(home)); }
  catch (error) { await release(); throw error; }
  const token = randomBytes(32).toString('hex');
  const instanceId = randomUUID();
  let port = 0;
  let stopping: Promise<void> | undefined;
  const audit = async (record: Record<string, unknown>) => {
    await appendFile(join(home, 'audit.jsonl'), JSON.stringify({ timestamp: new Date().toISOString(), ...record }) + '\n', { mode: 0o600 });
  };
  const respond = (response: ServerResponse, status: number, payload: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    response.end(JSON.stringify(payload));
  };
  const server = createServer((request, response) => {
    void (async () => {
      const start = Date.now();
      const requestId = randomUUID();
      let rpc: RpcRequest | undefined;
      let resultCode = 'OK';
      try {
        if (stopping) throw new KeelError('BROKER_STOPPING', 'Router is stopping.');
        if (request.headers.host !== `127.0.0.1:${port}` || request.headers.origin !== undefined)
          throw new KeelError('FORBIDDEN_ORIGIN', 'Browser-origin requests are not allowed.');
        const expected = Buffer.from(`Bearer ${token}`);
        const actual = Buffer.from(request.headers.authorization ?? '');
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
          throw new KeelError('UNAUTHORIZED', 'Router authentication is required.');
        if (request.method !== 'POST' || request.url !== '/rpc')
          throw new KeelError('INVALID_REQUEST', 'Use the authenticated RPC endpoint.');
        rpc = await body(request);
        let result: unknown;
        if (rpc.method === '$ping') result = { running: true, pid: process.pid, port, instanceId };
        else if (rpc.method === '$stop') { await stop(); result = { stopped: true }; }
        else result = await engine.call(rpc);
        respond(response, 200, { ok: true, result });
      } catch (error) {
        const safe = safeError(error);
        resultCode = safe.code;
        respond(response, safe.code === 'UNAUTHORIZED' ? 401 : safe.code === 'FORBIDDEN_ORIGIN' ? 403 : 400, { ok: false, error: safe });
      } finally {
        await audit({ requestId, method: rpc?.method ?? 'rejected', clientId: rpc?.clientId, sessionId: safeId(rpc?.sessionId), tabId: safeId(rpc?.params?.tabId), durationMs: Date.now() - start, result: resultCode });
      }
    })().catch(() => { if (!response.headersSent) respond(response, 500, { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Router request failed.' } }); });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 30;
  try {
    await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
    port = (server.address() as { port: number }).port;
    engine.setBrokerPort?.(port);
    const state: BrokerState = { pid: process.pid, port, token, instanceId };
    await writePrivate(join(home, 'broker.json'), state);
  } catch (error) { server.close(); await release(); throw error; }
  const interval = setInterval(() => { void engine.sweep().catch(() => {}); }, 10_000);
  interval.unref();
  function stop(): Promise<void> {
    if (stopping) return stopping;
    stopping = (async () => {
      // Keep the process, credentials, and listener available for a cleanup retry on failure.
      await engine.shutdown();
      clearInterval(interval);
      server.close();
      server.closeIdleConnections();
      const current = await readState(home).catch(() => undefined);
      if (current?.instanceId === instanceId) await unlink(join(home, 'broker.json')).catch(() => {});
      await release();
      options.onStopped?.();
    })().catch(error => { stopping = undefined; throw error; });
    return stopping;
  }
  return { port, token, instanceId, stop };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer({ onStopped: () => { setTimeout(() => process.exit(0), 50); } }).then(handle => {
    const shutdown = () => { void handle.stop().catch(error => process.stderr.write(JSON.stringify(safeError(error)) + '\n')); };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }).catch(error => { process.stderr.write(JSON.stringify(safeError(error)) + '\n'); process.exitCode = 1; });
}
