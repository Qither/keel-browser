import { KeelError } from './contracts.js';

export interface PopupOwner { isActive(): boolean }
export interface PopupGuard { close(): Promise<void>; isHealthy(): boolean }
export interface PopupGuardCallbacks {
  ownerForTarget(targetId: string): PopupOwner | undefined;
  registerOwnedTarget(targetId: string, owner: PopupOwner): void;
  allowsRequest(url: string): boolean;
  onFailure?(): void;
}

interface PendingCommand {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  sessionId?: string;
}
interface ChildTarget { targetId: string; owner?: PopupOwner; waiting: boolean }
interface ProtocolMessage {
  id?: number;
  result?: unknown;
  error?: unknown;
  method?: string;
  sessionId?: string;
  params?: {
    sessionId?: string;
    targetInfo?: { targetId: string; openerId?: string; type: string };
    waitingForDebugger?: boolean;
    requestId?: string;
    request?: { url: string };
  };
}

const guardError = () => new KeelError('POPUP_GUARD_FAILED', 'The browser popup request guard is unavailable.');

async function resolveWebSocket(endpoint: string, timeoutMs: number): Promise<string> {
  try {
    const url = new URL(endpoint);
    if (url.username || url.password) throw guardError();
    if (url.protocol === 'ws:' || url.protocol === 'wss:') return url.href;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw guardError();
    const response = await fetch(new URL('/json/version', url), { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!response.ok) throw guardError();
    const result = await response.json() as { webSocketDebuggerUrl?: unknown };
    if (typeof result.webSocketDebuggerUrl !== 'string') throw guardError();
    const socketUrl = new URL(result.webSocketDebuggerUrl);
    if (!['ws:', 'wss:'].includes(socketUrl.protocol) || socketUrl.username || socketUrl.password) throw guardError();
    return socketUrl.href;
  } catch { throw guardError(); }
}

async function openSocket(endpoint: string, timeoutMs: number): Promise<WebSocket> {
  let socket: WebSocket;
  try { socket = new WebSocket(endpoint); } catch { throw guardError(); }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener('open', opened);
      socket.removeEventListener('error', failed);
      socket.removeEventListener('close', failed);
    };
    const opened = () => { cleanup(); resolve(socket); };
    const failed = () => {
      cleanup();
      try { socket.close(); } catch { /* Already disconnected. */ }
      reject(guardError());
    };
    const timer = setTimeout(failed, timeoutMs);
    socket.addEventListener('open', opened, { once: true });
    socket.addEventListener('error', failed, { once: true });
    socket.addEventListener('close', failed, { once: true });
  });
}

/** A second CDP connection pauses new page targets before their first request. */
class BrowserPopupGuard implements PopupGuard {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly children = new Map<string, ChildTarget>();
  private readonly ownedTargets = new Set<string>();
  private readonly attachmentTasks = new Set<Promise<void>>();
  private failed = false;
  private closing = false;
  private cleanupFailure = false;
  private closePromise?: Promise<void>;

  constructor(private readonly socket: WebSocket, private readonly callbacks: PopupGuardCallbacks, private readonly timeoutMs: number, private readonly endpoint: string) {
    socket.addEventListener('message', event => {
      try {
        if (typeof event.data !== 'string') throw guardError();
        this.receive(JSON.parse(event.data) as ProtocolMessage);
      } catch { this.fail(); }
    });
    socket.addEventListener('error', () => this.fail());
    socket.addEventListener('close', () => this.fail());
  }

  async install(): Promise<void> {
    await this.command('Target.setAutoAttach', {
      autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
      filter: [{ type: 'page', exclude: false }, { exclude: true }],
    });
    if (!this.isHealthy()) throw guardError();
  }

  isHealthy(): boolean { return !this.failed && !this.closing && this.socket.readyState === WebSocket.OPEN; }

  close(): Promise<void> {
    if (!this.closePromise) {
      const attempt = this.finishClose();
      this.closePromise = attempt;
      void attempt.catch(() => { if (this.closePromise === attempt) this.closePromise = undefined; });
    }
    return this.closePromise;
  }

  private async finishClose(): Promise<void> {
    this.closing = true;
    this.cleanupFailure = false;
    let cleanupFailed = false;
    if (!this.failed && this.socket.readyState === WebSocket.OPEN) {
      const results = await Promise.allSettled([
        ...[...this.ownedTargets].map(targetId => this.closeOwnedTarget(targetId)),
        ...[...this.children.entries()].filter(([, child]) => !child.owner && child.waiting).map(([sessionId]) => this.resume(sessionId)),
      ]);
      cleanupFailed = results.some(result => result.status === 'rejected');
      if (cleanupFailed) throw new KeelError('POPUP_GUARD_CLEANUP_FAILED', 'Unable to confirm cleanup of browser popup targets.');
      await this.command('Target.setAutoAttach', {
        autoAttach: false, waitForDebuggerOnStart: false, flatten: true,
      }).catch(() => { cleanupFailed = true; });
      await Promise.allSettled([...this.attachmentTasks]);
    } else if (this.ownedTargets.size > 0) {
      // The owner may already have closed these tabs after guard transport loss.
      // Confirm or finish cleanup through a fresh connection without auto-attach.
      await this.recoverOwnedTargets().catch(() => { cleanupFailed = true; });
    }
    if (cleanupFailed || this.cleanupFailure || this.ownedTargets.size > 0) {
      throw new KeelError('POPUP_GUARD_CLEANUP_FAILED', 'Unable to confirm cleanup of browser popup targets.');
    }
    this.rejectPending();
    this.children.clear();
    try { this.socket.close(); } catch { /* Already disconnected. */ }
  }

  private command(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    if (this.failed || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(guardError());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(guardError());
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, sessionId });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(guardError());
      }
    });
  }

  private receive(message: ProtocolMessage): void {
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(guardError());
        else pending.resolve(message.result);
      }
      return;
    }
    if (this.failed) return;
    if (message.method === 'Target.attachedToTarget') {
      const sessionId = message.params?.sessionId;
      const info = message.params?.targetInfo;
      if (!sessionId || !info || info.type !== 'page') { this.fail(); return; }
      const task = this.attached(sessionId, info, message.params?.waitingForDebugger === true).catch(() => {
        if (!this.children.has(sessionId)) return;
        if (this.closing) this.cleanupFailure = true;
        else this.fail();
      });
      this.attachmentTasks.add(task);
      void task.finally(() => this.attachmentTasks.delete(task));
    } else if (message.method === 'Target.detachedFromTarget') {
      const sessionId = message.params?.sessionId;
      if (sessionId) {
        this.children.delete(sessionId);
        for (const [id, pending] of this.pending) {
          if (pending.sessionId === sessionId) {
            this.pending.delete(id); clearTimeout(pending.timer); pending.reject(guardError());
          }
        }
      }
    } else if (message.method === 'Fetch.requestPaused') {
      void this.intercept(message).catch(() => {
        if (message.sessionId && this.children.has(message.sessionId) && !this.closing) this.fail();
      });
    }
  }

  private async attached(sessionId: string, info: { targetId: string; openerId?: string }, waiting: boolean): Promise<void> {
    const owner = info.openerId ? this.callbacks.ownerForTarget(info.openerId) : undefined;
    this.children.set(sessionId, { targetId: info.targetId, owner, waiting });
    if (owner) {
      this.ownedTargets.add(info.targetId);
      this.callbacks.registerOwnedTarget(info.targetId, owner);
      if (!owner.isActive() || this.closing) {
        await this.closeOwnedTarget(info.targetId);
        return;
      }
      try {
        await this.command('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sessionId);
      } catch {
        // An owned popup must never resume without its first-request guard.
        await this.closeOwnedTarget(info.targetId).catch(() => undefined);
        throw guardError();
      }
      if (!owner.isActive() || this.closing) {
        await this.closeOwnedTarget(info.targetId);
        return;
      }
    }
    if (waiting) await this.resume(sessionId);
  }

  private async resume(sessionId: string): Promise<void> {
    await this.command('Runtime.runIfWaitingForDebugger', {}, sessionId);
    const child = this.children.get(sessionId);
    if (child) child.waiting = false;
  }

  private async closeOwnedTarget(targetId: string): Promise<void> {
    try {
      const result = await this.command('Target.closeTarget', { targetId }) as { success?: boolean };
      if (result.success !== true) throw guardError();
      this.ownedTargets.delete(targetId);
    } catch {
      // A detached protocol session alone does not prove the browser tab closed.
      const result = await this.command('Target.getTargets') as { targetInfos?: { targetId: string }[] };
      if (!Array.isArray(result.targetInfos) || result.targetInfos.some(info => info.targetId === targetId)) throw guardError();
      this.ownedTargets.delete(targetId);
    }
  }

  private async recoverOwnedTargets(): Promise<void> {
    const socket = await openSocket(this.endpoint, this.timeoutMs);
    const bridge = new BrowserPopupGuard(socket, {
      ownerForTarget: () => undefined,
      registerOwnedTarget: () => undefined,
      allowsRequest: () => false,
    }, this.timeoutMs, this.endpoint);
    try {
      const results = await Promise.allSettled([...this.ownedTargets].map(async targetId => {
        await bridge.closeOwnedTarget(targetId);
        this.ownedTargets.delete(targetId);
      }));
      if (results.some(result => result.status === 'rejected')) throw guardError();
    } finally {
      bridge.closing = true;
      bridge.rejectPending();
      try { socket.close(); } catch { /* Already disconnected. */ }
    }
  }

  private async intercept(message: ProtocolMessage): Promise<void> {
    const sessionId = message.sessionId;
    const requestId = message.params?.requestId;
    const url = message.params?.request?.url;
    if (!sessionId || !requestId || typeof url !== 'string') { this.fail(); return; }
    const owner = this.children.get(sessionId)?.owner;
    const allowed = !!owner && owner.isActive() && this.callbacks.allowsRequest(url);
    await this.command(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', {
      requestId, ...(!allowed ? { errorReason: 'BlockedByClient' } : {}),
    }, sessionId);
  }

  private rejectPending(): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(guardError()); }
    this.pending.clear();
  }

  private fail(): void {
    if (this.failed) return;
    this.failed = true;
    this.rejectPending();
    if (!this.closing) {
      try { this.callbacks.onFailure?.(); } catch { /* A notification cannot expose protocol errors. */ }
    }
    // Losing this connection must release auto-attach barriers on manual pages.
    try { this.socket.close(); } catch { /* Already disconnected. */ }
  }
}

export async function installPopupGuard(endpoint: string, callbacks: PopupGuardCallbacks, timeoutMs: number): Promise<PopupGuard> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw guardError();
  const websocketEndpoint = await resolveWebSocket(endpoint, timeoutMs);
  const socket = await openSocket(websocketEndpoint, timeoutMs);
  const guard = new BrowserPopupGuard(socket, callbacks, timeoutMs, websocketEndpoint);
  try { await guard.install(); return guard; }
  catch {
    try { await guard.close().catch(() => undefined); }
    finally {
      // Failed installation has no caller-held guard to retry. Always release
      // this debug connection, including when auto-attach cleanup also times out.
      try { socket.close(); } catch { /* Already disconnected. */ }
    }
    throw guardError();
  }
}
