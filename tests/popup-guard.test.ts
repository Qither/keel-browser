import { afterEach, describe, expect, it, vi } from 'vitest';
import { installPopupGuard, type PopupGuard, type PopupGuardCallbacks, type PopupOwner } from '../src/popup-guard.js';

interface Command { id: number; method: string; params: Record<string, unknown>; sessionId?: string }
type Reply = { result?: unknown; error?: unknown } | undefined;

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  sent: Command[] = [];
  closeCalls = 0;
  reply: (command: Command) => Reply = command => ({ result: command.method === 'Target.closeTarget' ? { success: true } : {} });

  constructor(_endpoint: string) {
    super();
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => { this.readyState = FakeWebSocket.OPEN; this.dispatchEvent(new Event('open')); });
  }
  send(text: string): void {
    const command = JSON.parse(text) as Command;
    this.sent.push(command);
    const reply = this.reply(command);
    if (reply) queueMicrotask(() => this.emit({ id: command.id, ...reply }));
  }
  close(): void {
    this.closeCalls++;
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event('close'));
  }
  emit(message: unknown): void { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); }
  attach(targetId: string, waitingForDebugger: boolean, openerId?: string): void {
    this.emit({ method: 'Target.attachedToTarget', params: {
      sessionId: `session-${targetId}`, waitingForDebugger,
      targetInfo: { targetId, type: 'page', ...(openerId ? { openerId } : {}) },
    } });
  }
}

const guards: PopupGuard[] = [];
afterEach(async () => {
  for (const guard of guards.splice(0)) await guard.close().catch(() => {});
  FakeWebSocket.instances.length = 0;
  vi.unstubAllGlobals();
});
async function fixture(timeoutMs = 100) {
  vi.stubGlobal('WebSocket', FakeWebSocket);
  const owners = new Map<string, PopupOwner>();
  const onFailure = vi.fn();
  const callbacks: PopupGuardCallbacks = {
    ownerForTarget: targetId => owners.get(targetId),
    registerOwnedTarget: (targetId, owner) => { owners.set(targetId, owner); },
    allowsRequest: url => !url.includes('127.0.0.1:55173'),
    onFailure,
  };
  const guard = await installPopupGuard('ws://127.0.0.1:9222/devtools/browser/test', callbacks, timeoutMs);
  guards.push(guard);
  return { guard, socket: FakeWebSocket.instances.at(-1)!, owners, onFailure };
}
async function settle(): Promise<void> { for (let i = 0; i < 20; i++) await Promise.resolve(); }

describe('raw popup guard lifecycle', () => {
  it('disconnects if installation and its cleanup both receive no protocol response', async () => {
    class SilentSocket extends FakeWebSocket {
      constructor(endpoint: string) { super(endpoint); this.reply = () => undefined; }
    }
    vi.stubGlobal('WebSocket', SilentSocket);
    await expect(installPopupGuard('ws://127.0.0.1:9222/devtools/browser/test', {
      ownerForTarget: () => undefined, registerOwnedTarget: () => {}, allowsRequest: () => true,
    }, 20)).rejects.toMatchObject({ code: 'POPUP_GUARD_FAILED' });
    expect(FakeWebSocket.instances.at(-1)?.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it('disconnects on malformed protocol input so future manual pages cannot remain debugger-paused', async () => {
    const f = await fixture();
    f.socket.dispatchEvent(new MessageEvent('message', { data: 'invalid protocol JSON' }));
    await settle();
    expect(f.guard.isHealthy()).toBe(false);
    expect(f.socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(f.onFailure).toHaveBeenCalledTimes(1);
  });

  it('disconnects when a popup guard command times out, without resuming the unprotected owned popup', async () => {
    const f = await fixture(25);
    f.owners.set('parent', { isActive: () => true });
    f.socket.reply = command => command.method === 'Fetch.enable' ? undefined : { result: command.method === 'Target.closeTarget' ? { success: true } : {} };
    f.socket.attach('popup', true, 'parent');
    await vi.waitFor(() => expect(f.socket.readyState).toBe(FakeWebSocket.CLOSED), { timeout: 500, interval: 10 });
    expect(f.onFailure).toHaveBeenCalledTimes(1);
    expect(f.socket.sent.some(command => command.method === 'Runtime.runIfWaitingForDebugger' && command.sessionId === 'session-popup')).toBe(false);
  });

  it('leaves existing manual targets alone and promptly resumes only new targets paused by this guard', async () => {
    const f = await fixture();
    f.socket.attach('manual-existing', false);
    f.socket.attach('manual-new', true);
    await settle();
    const resumed = f.socket.sent.filter(command => command.method === 'Runtime.runIfWaitingForDebugger');
    expect(resumed.map(command => command.sessionId)).toEqual(['session-manual-new']);
    expect(f.socket.sent.some(command => command.method === 'Fetch.enable')).toBe(false);
    expect(f.owners.size).toBe(0);
  });

  it('installs Fetch before resuming an owned popup and applies its policy to each paused request', async () => {
    const f = await fixture();
    let active = true;
    const owner = { isActive: () => active };
    f.owners.set('parent', owner);
    f.socket.attach('popup', true, 'parent');
    await settle();
    expect(f.owners.get('popup')).toBe(owner);
    const popupCommands = f.socket.sent.filter(command => command.sessionId === 'session-popup');
    expect(popupCommands.map(command => command.method)).toEqual(['Fetch.enable', 'Runtime.runIfWaitingForDebugger']);
    for (const [requestId, url] of [['allowed', 'https://example.test/page'], ['blocked', 'http://127.0.0.1:55173/status']]) {
      f.socket.emit({ method: 'Fetch.requestPaused', sessionId: 'session-popup', params: { requestId, request: { url } } });
    }
    await settle();
    expect(f.socket.sent).toContainEqual(expect.objectContaining({ method: 'Fetch.continueRequest', params: { requestId: 'allowed' } }));
    expect(f.socket.sent).toContainEqual(expect.objectContaining({ method: 'Fetch.failRequest', params: { requestId: 'blocked', errorReason: 'BlockedByClient' } }));
    active = false;
    f.socket.emit({ method: 'Fetch.requestPaused', sessionId: 'session-popup', params: { requestId: 'inactive', request: { url: 'https://example.test/page' } } });
    await settle();
    expect(f.socket.sent).toContainEqual(expect.objectContaining({ method: 'Fetch.failRequest', params: { requestId: 'inactive', errorReason: 'BlockedByClient' } }));
  });

  it('retains a failed owned-target close for retry and does not report an intentional shutdown as guard failure', async () => {
    const f = await fixture();
    f.owners.set('parent', { isActive: () => true });
    f.socket.attach('popup', true, 'parent');
    await settle();
    let closeAttempts = 0;
    f.socket.reply = command => {
      if (command.method === 'Target.closeTarget') return ++closeAttempts === 1 ? { error: { code: -32000, message: 'fixture close failed' } } : { result: { success: true } };
      return { result: {} };
    };
    await expect(f.guard.close()).rejects.toMatchObject({ code: 'POPUP_GUARD_CLEANUP_FAILED' });
    expect(f.socket.readyState).toBe(FakeWebSocket.OPEN);
    expect(f.onFailure).not.toHaveBeenCalled();
    await expect(f.guard.close()).resolves.toBeUndefined();
    expect(closeAttempts).toBe(2);
    expect(f.socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(f.onFailure).not.toHaveBeenCalled();
  });

  it('waits for acknowledgment when an owned popup arrives during shutdown', async () => {
    const f = await fixture();
    f.owners.set('parent', { isActive: () => true });
    f.socket.attach('first', true, 'parent');
    await settle();
    f.socket.reply = command => command.method === 'Target.closeTarget' ? undefined : { result: {} };
    let completed = false;
    const closing = f.guard.close().then(() => { completed = true; });
    f.socket.attach('late', true, 'parent');
    await settle();
    const firstClose = f.socket.sent.find(command => command.method === 'Target.closeTarget' && command.params.targetId === 'first')!;
    const lateClose = f.socket.sent.find(command => command.method === 'Target.closeTarget' && command.params.targetId === 'late')!;
    expect(firstClose).toBeDefined();
    expect(lateClose).toBeDefined();
    f.socket.emit({ id: firstClose.id, result: { success: true } });
    await settle();
    expect(completed).toBe(false);
    expect(f.socket.readyState).toBe(FakeWebSocket.OPEN);
    f.socket.emit({ id: lateClose.id, result: { success: true } });
    await closing;
    expect(completed).toBe(true);
    expect(f.socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(f.socket.sent.some(command => command.method === 'Runtime.runIfWaitingForDebugger' && command.sessionId === 'session-late')).toBe(false);
    expect(f.onFailure).not.toHaveBeenCalled();
  });
});
