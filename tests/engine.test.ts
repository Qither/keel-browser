import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright-core';
import { createEngine } from '../src/engine.js';
import { type ClientId, type ProfileAlias, type KeelConfig, type OpenResult, type RouterEngine } from '../src/contracts.js';
import type { PopupGuardCallbacks } from '../src/popup-guard.js';

const CODEX_PROFILE_ID = '00000000-0000-4000-8000-000000000001';
const CLAUDE_PROFILE_ID = '00000000-0000-4000-8000-000000000002';
const config: KeelConfig = { provider: 'multizen', profiles: { codex: { id: CODEX_PROFILE_ID, name: 'codex' }, claude: { id: CLAUDE_PROFILE_ID, name: 'claude' } }, mcpUrl: 'http://127.0.0.1:55173/mcp', tokenEnv: 'MULTIZEN_MCP_TOKEN', tokenFile: 'fixture-token',
  cliIdleMs: 1_800_000, mcpLeaseMs: 30_000, operationTimeoutMs: 1000, providerTimeoutMs: 1000 };
class FakeElement {
  connected = true;
  disposed = false;
  calls: string[] = [];
  evaluateGate?: Promise<unknown>;
  async evaluate(fn: Function) {
    await this.evaluateGate;
    if (fn.toString().includes('element.isConnected')) return this.connected;
    return { tag: 'button', role: 'button', label: 'button', text: 'Button', disabled: false };
  }
  async click() { this.calls.push('click'); }
  async fill(value: string) { this.calls.push(`fill:${value}`); }
  async press(key: string) { this.calls.push(`press:${key}`); }
  async dispose() { this.disposed = true; }
}
class FakePage extends EventEmitter {
  closed = false;
  address = 'about:blank';
  navigations: string[] = [];
  elements = [new FakeElement()];
  routeHandler?: (route: unknown) => Promise<unknown>;
  wsHandler?: (socket: unknown) => unknown;
  gotoGate?: Promise<unknown>;
  closeCalls = 0;
  parent: FakePage | null = null;
  mouse = { wheel: vi.fn(async () => {}) };
  url() { return this.address; }
  isClosed() { return this.closed; }
  mainFrame() { return this; }
  async opener() { return this.parent; }
  async route(_pattern: string, handler: (route: unknown) => Promise<unknown>) { this.routeHandler = handler; }
  async routeWebSocket(_pattern: string, handler: (socket: unknown) => unknown) { this.wsHandler = handler; }
  async goto(url: string) { this.navigations.push(url); await this.gotoGate; this.address = url; this.emit('framenavigated', this); }
  async close() { this.closeCalls++; this.closed = true; this.emit('close'); }
  async $$() { return this.elements; }
  async evaluate() { return { text: 'Page content', truncated: false }; }
  async title() { return 'Fixture'; }
}
class FakeContext {
  manual = new FakePage();
  created: FakePage[] = [];
  newPageGate?: Promise<unknown>;
  routeHandler?: (route: unknown) => Promise<unknown>;
  cdpCalls: Array<{ page: FakePage; method: string; params?: unknown }> = [];
  cdpDetachCount = 0;
  screenshotError?: Error;
  async newCDPSession(page: FakePage) {
    return { on: () => {}, send: async (method: string, params?: unknown) => {
      this.cdpCalls.push({ page, method, params });
      if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: `fake-${this.created.indexOf(page)}` } };
      if (method === 'Page.captureScreenshot') {
        if (this.screenshotError) throw this.screenshotError;
        return { data: Buffer.from('png fixture').toString('base64') };
      }
      return {};
    }, detach: async () => { this.cdpDetachCount++; } };
  }
  async route(_pattern: string, handler: (route: unknown) => Promise<unknown>) { this.routeHandler = handler; }
  async newPage() { await this.newPageGate; const page = new FakePage(); this.created.push(page); return page; }
  pages() { return [this.manual, ...this.created]; }
}
class FakeBrowser extends EventEmitter {
  connected = true;
  context = new FakeContext();
  isConnected() { return this.connected; }
  contexts() { return [this.context]; }
  disconnect() { this.connected = false; this.emit('disconnected'); }
}
const engines: RouterEngine[] = [];
function fixture(overrides: Partial<KeelConfig> = {}) {
  const browser = new FakeBrowser();
  const provider = { connectInfo: vi.fn(async () => ({ profileId: CODEX_PROFILE_ID, name: 'codex renamed', cdpEndpoint: 'http://127.0.0.1:9333' })) };
  const connect = vi.fn(async () => browser as unknown as Browser);
  let time = 1000;
  const engine = createEngine({ ...config, ...overrides }, { provider, connect, now: () => time,
    installPopupGuard: async () => ({ isHealthy: () => true, close: async () => {} }) });
  engines.push(engine);
  const open = async (mode: 'cli' | 'mcp' = 'cli', url?: string) => engine.call({ method: 'open', params: { mode, ...(url ? { url } : {}) } }) as Promise<OpenResult>;
  return { engine, browser, provider, connect, open, tick: (ms: number) => { time += ms; } };
}
function multiProfileFixture() {
  const browsers = { codex: new FakeBrowser(), claude: new FakeBrowser() };
  const endpoints = { codex: 'http://127.0.0.1:9333', claude: 'http://127.0.0.1:9444' };
  const providers = {
    codex: { connectInfo: vi.fn(async () => ({ profileId: CODEX_PROFILE_ID, name: 'codex', cdpEndpoint: endpoints.codex })) },
    claude: { connectInfo: vi.fn(async () => ({ profileId: CLAUDE_PROFILE_ID, name: 'claude', cdpEndpoint: endpoints.claude })) },
  };
  const providerFor = vi.fn((alias: ProfileAlias) => providers[alias]);
  const connect = vi.fn(async (endpoint: string) => {
    const alias = endpoint === endpoints.codex ? 'codex' : 'claude';
    return browsers[alias] as unknown as Browser;
  });
  const callbacks = new Map<ProfileAlias, PopupGuardCallbacks>();
  const guards = { codex: { isHealthy: () => true, close: vi.fn(async () => {}) }, claude: { isHealthy: () => true, close: vi.fn(async () => {}) } };
  const engine = createEngine(config, { providerFor, connect,
    installPopupGuard: async (endpoint, handlers) => {
      const alias = endpoint === endpoints.codex ? 'codex' : 'claude';
      callbacks.set(alias, handlers);
      return guards[alias];
    },
  });
  engines.push(engine);
  const open = (clientId: ClientId) => engine.call({ method: 'open', clientId, params: { mode: 'mcp' } }) as Promise<OpenResult>;
  return { engine, browsers, providers, providerFor, connect, callbacks, guards, open };
}
function request(engine: RouterEngine, session: OpenResult, method: string, params?: Record<string, unknown>) {
  return engine.call({ method, clientId: session.clientId, sessionId: session.sessionId, capability: session.capability, params });
}
function tabId(session: OpenResult) { return session.tabs[0]!.tabId; }
afterEach(async () => { vi.useRealTimers(); await Promise.allSettled(engines.splice(0).map(engine => engine.shutdown())); });

describe('shared profile session engine', () => {
  it('single-flights concurrent connections and creates a fresh owned tab per session', async () => {
    const { open, provider, connect, browser, engine } = fixture();
    const [a, b] = await Promise.all([open(), open()]);
    expect(provider.connectInfo).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(browser.context.created).toHaveLength(2);
    expect(a.profileId).toBe(CODEX_PROFILE_ID);
    expect(a.clientId).toBe('codex');
    expect(a.profileAlias).toBe('codex');
    expect(a.profileName).toBe('codex renamed');
    expect(a.capability).not.toBe(b.capability);
    expect(tabId(a)).not.toBe(tabId(b));
    await request(engine, a, 'close');
    expect(browser.context.created[0]!.closed).toBe(true);
    expect(browser.context.created[1]!.closed).toBe(false);
    expect(browser.context.manual.closeCalls).toBe(0);
    expect(browser.isConnected()).toBe(true);
  });

  it('rejects invalid credentials and cross-session tabs before any navigation', async () => {
    const { open, engine, browser } = fixture();
    const [a, b] = await Promise.all([open(), open()]);
    await expect(engine.call({ method: 'status', sessionId: a.sessionId, capability: b.capability })).rejects.toMatchObject({ code: 'INVALID_SESSION' });
    await expect(engine.call({ method: 'status', sessionId: a.sessionId, capability: 'short' })).rejects.toMatchObject({ code: 'INVALID_SESSION' });
    await expect(request(engine, a, 'navigate', { tabId: tabId(b), url: 'https://example.com' })).rejects.toMatchObject({ code: 'INVALID_TAB' });
    expect(browser.context.created.every(page => page.navigations.length === 0)).toBe(true);
  });

  it('isolates element references by session, tab and document and retains exact nodes', async () => {
    const { open, engine, browser } = fixture();
    const a = await open(); const b = await open();
    const snap = await request(engine, a, 'snapshot', { tabId: tabId(a) }) as { elements: Array<{ ref: string }> };
    const ref = snap.elements[0]!.ref;
    await expect(request(engine, b, 'click', { tabId: tabId(b), ref })).rejects.toMatchObject({ code: 'STALE_REF' });
    const original = browser.context.created[0]!.elements[0]!;
    original.connected = false;
    browser.context.created[0]!.elements = [new FakeElement()];
    await expect(request(engine, a, 'click', { tabId: tabId(a), ref })).rejects.toMatchObject({ code: 'STALE_REF' });
    expect(browser.context.created[0]!.elements[0]!.calls).toEqual([]);
    original.connected = true;
    await request(engine, a, 'navigate', { tabId: tabId(a), url: 'https://example.com' });
    await expect(request(engine, a, 'click', { tabId: tabId(a), ref })).rejects.toMatchObject({ code: 'STALE_REF' });
    expect(original.disposed).toBe(true);
  });

  it('invalidates previous snapshots, supports bounded actions, and does not echo fill text', async () => {
    const { open, engine, browser } = fixture(); const a = await open();
    const first = await request(engine, a, 'snapshot', { tabId: tabId(a) }) as { elements: Array<{ ref: string }> };
    const second = await request(engine, a, 'snapshot', { tabId: tabId(a) }) as { elements: Array<{ ref: string }> };
    await expect(request(engine, a, 'click', { tabId: tabId(a), ref: first.elements[0]!.ref })).rejects.toMatchObject({ code: 'STALE_REF' });
    const ref = second.elements[0]!.ref;
    const filled = await request(engine, a, 'fill', { tabId: tabId(a), ref, text: 'private-value' });
    expect(JSON.stringify(filled)).not.toContain('private-value');
    await request(engine, a, 'press', { tabId: tabId(a), ref, key: 'Enter' });
    await request(engine, a, 'scroll', { tabId: tabId(a), direction: 'down', amount: 450 });
    expect(browser.context.created[0]!.mouse.wheel).toHaveBeenCalledWith(0, 450);
    expect(await request(engine, a, 'screenshot', { tabId: tabId(a) })).toEqual({ mimeType: 'image/png', data: Buffer.from('png fixture').toString('base64') });
    await expect(request(engine, a, 'scroll', { tabId: tabId(a), direction: 'down', amount: Infinity })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('adopts only confirmed popups and leaves unrelated pages untouched', async () => {
    const { open, engine, browser } = fixture(); const a = await open();
    const popup = new FakePage(); const unrelated = new FakePage();
    browser.context.created[0]!.emit('popup', popup);
    const tabs = await request(engine, a, 'tabs') as unknown[];
    expect(tabs).toHaveLength(2);
    await request(engine, a, 'close');
    expect(popup.closed).toBe(true);
    expect(unrelated.closed).toBe(false);
    expect(browser.context.manual.closed).toBe(false);
  });

  it('captures only the requested owned target surface and releases its temporary CDP session', async () => {
    const { open, engine, browser } = fixture(); const a = await open(); const b = await open();
    const before = browser.context.cdpDetachCount;
    await request(engine, b, 'screenshot', { tabId: tabId(b) });
    expect(browser.context.cdpCalls.filter(call => call.method === 'Page.captureScreenshot')).toEqual([
      { page: browser.context.created[1], method: 'Page.captureScreenshot', params: { format: 'png', fromSurface: true, captureBeyondViewport: false } },
    ]);
    expect(browser.context.cdpDetachCount).toBe(before + 1);
    await expect(request(engine, a, 'screenshot', { tabId: tabId(b) })).rejects.toMatchObject({ code: 'INVALID_TAB' });
    expect(browser.context.cdpCalls.filter(call => call.method === 'Page.captureScreenshot')).toHaveLength(1);
    expect(browser.context.manual.closed).toBe(false);
  });

  it('serializes one session while allowing other sessions to progress', async () => {
    const { open, engine, browser } = fixture(); const a = await open(); const b = await open();
    let release!: () => void;
    browser.context.created[0]!.gotoGate = new Promise<void>(resolve => { release = resolve; });
    const first = request(engine, a, 'navigate', { tabId: tabId(a), url: 'https://example.com/one' });
    const second = request(engine, a, 'navigate', { tabId: tabId(a), url: 'https://example.com/two' });
    await request(engine, b, 'navigate', { tabId: tabId(b), url: 'https://example.com/other' });
    expect(browser.context.created[0]!.navigations).toEqual(['https://example.com/one']);
    expect(browser.context.created[1]!.navigations).toEqual(['https://example.com/other']);
    release(); await Promise.all([first, second]);
    expect(browser.context.created[0]!.navigations).toHaveLength(2);
  });

  it('expires queued actions before starting them instead of performing stale mutations', async () => {
    const { open, engine, browser, tick } = fixture(); const a = await open();
    let release!: () => void;
    browser.context.created[0]!.gotoGate = new Promise<void>(resolve => { release = resolve; });
    const first = request(engine, a, 'navigate', { tabId: tabId(a), url: 'https://example.com/first' });
    const queued = request(engine, a, 'navigate', { tabId: tabId(a), url: 'https://example.com/expired' });
    await new Promise(resolve => setImmediate(resolve));
    tick(config.operationTimeoutMs + 1); release();
    await first;
    await expect(queued).rejects.toMatchObject({ code: 'QUEUE_TIMEOUT' });
    expect(browser.context.created[0]!.navigations).toEqual(['https://example.com/first']);
  });

  it('pauses after timeout and refuses queued work while unresolved work can finish', async () => {
    const { open, engine, browser } = fixture({ operationTimeoutMs: 25 }); const a = await open();
    let release!: () => void;
    browser.context.created[0]!.gotoGate = new Promise<void>(resolve => { release = resolve; });
    const pending = request(engine, a, 'navigate', { tabId: tabId(a), url: 'https://example.com/slow' });
    const queued = request(engine, a, 'navigate', { tabId: tabId(a), url: 'https://example.com/never' });
    const errors = await Promise.allSettled([pending, queued]);
    expect(errors[0]).toMatchObject({ status: 'rejected', reason: { code: 'OPERATION_TIMEOUT' } });
    expect(errors[1]).toMatchObject({ status: 'rejected', reason: { code: 'SESSION_UNAVAILABLE' } });
    expect(await request(engine, a, 'status')).toMatchObject({ status: 'paused' });
    await request(engine, a, 'close');
    release(); await Promise.resolve();
    expect(browser.context.created[0]!.navigations).toEqual(['https://example.com/slow']);
  });

  it('closes tabs that finish creating after an open timeout', async () => {
    const { open, engine, browser } = fixture({ operationTimeoutMs: 25 });
    let release!: () => void;
    browser.context.newPageGate = new Promise<void>(resolve => { release = resolve; });
    await expect(open()).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    release(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(browser.context.created[0]!.closed).toBe(true);
    await engine.shutdown();
    expect(browser.context.manual.closeCalls).toBe(0);
  });

  it('rejects queued mutations during close and closes only after bounded in-flight settlement', async () => {
    const { open, engine, browser } = fixture(); const a = await open();
    let release!: () => void;
    browser.context.created[0]!.gotoGate = new Promise<void>(resolve => { release = resolve; });
    const operation = request(engine, a, 'navigate', { tabId: tabId(a), url: 'https://example.com/pending' }).catch(error => error);
    await new Promise(resolve => setImmediate(resolve));
    const closing = request(engine, a, 'close');
    await expect(request(engine, a, 'navigate', { tabId: tabId(a), url: 'https://example.com/rejected' })).rejects.toMatchObject({ code: 'SESSION_UNAVAILABLE' });
    release();
    expect(await operation).toMatchObject({ code: 'SESSION_UNAVAILABLE' });
    expect(await closing).toMatchObject({ status: 'closed' });
    expect(browser.context.created[0]!.navigations).toEqual(['https://example.com/pending']);
    expect(browser.context.created[0]!.closed).toBe(true);
    expect(browser.context.manual.closed).toBe(false);
  });

  it('disposes snapshot handles that return after a session timeout', async () => {
    const { open, engine, browser } = fixture({ operationTimeoutMs: 25 }); const a = await open();
    let release!: () => void;
    const handle = browser.context.created[0]!.elements[0]!;
    handle.evaluateGate = new Promise<void>(resolve => { release = resolve; });
    await expect(request(engine, a, 'snapshot', { tabId: tabId(a) })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    release(); await new Promise(resolve => setImmediate(resolve));
    expect(handle.disposed).toBe(true);
    expect(await request(engine, a, 'status')).toMatchObject({ status: 'paused' });
  });

  it('invalidates disconnected sessions and reconnects only on a new open', async () => {
    const { open, engine, browser, connect } = fixture(); const a = await open();
    browser.disconnect();
    expect(await request(engine, a, 'status')).toMatchObject({ status: 'disconnected' });
    await expect(request(engine, a, 'navigate', { tabId: tabId(a), url: 'https://example.com' })).rejects.toMatchObject({ code: 'SESSION_UNAVAILABLE' });
    expect(connect).toHaveBeenCalledTimes(1);
    const replacement = new FakeBrowser(); connect.mockResolvedValueOnce(replacement as unknown as Browser);
    await open();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(replacement.context.created).toHaveLength(1);
  });

  it('expires CLI idle time and MCP leases independently, while heartbeat renews its owner', async () => {
    const { open, engine, browser, tick } = fixture({ cliIdleMs: 1000, mcpLeaseMs: 100 });
    const cli = await open('cli'); const mcp = await open('mcp');
    tick(90); await request(engine, mcp, 'heartbeat'); tick(90); await engine.sweep();
    expect(browser.context.created.every(page => !page.closed)).toBe(true);
    tick(20); await engine.sweep();
    expect(browser.context.created[1]!.closed).toBe(true);
    expect(await request(engine, cli, 'status')).toMatchObject({ status: 'active' });
    tick(1001); await engine.sweep();
    expect(browser.context.created[0]!.closed).toBe(true);
    expect(browser.context.manual.closed).toBe(false);
  });

  it('blocks control navigation, resource requests and redirected endpoints', async () => {
    const { open, engine, browser } = fixture(); engine.setBrokerPort!(8111); const a = await open();
    for (const url of ['file:///etc/passwd', 'http://localhost:55173/api', 'http://127.0.0.1:9333/json', 'http://[::1]:8111/rpc']) {
      await expect(request(engine, a, 'navigate', { tabId: tabId(a), url })).rejects.toBeInstanceOf(Error);
    }
    const abort = vi.fn(async () => {}); const proceed = vi.fn(async () => {});
    await browser.context.created[0]!.routeHandler!({ request: () => ({ url: () => 'http://localhost:55173/redirect-target' }), abort, continue: proceed });
    expect(abort).toHaveBeenCalledWith('blockedbyclient'); expect(proceed).not.toHaveBeenCalled();
    const close = vi.fn(async () => {}); const connectToServer = vi.fn();
    await browser.context.created[0]!.wsHandler!({ url: () => 'ws://127.0.0.1:9333/private', close, connectToServer });
    expect(close).toHaveBeenCalled(); expect(connectToServer).not.toHaveBeenCalled();
    await browser.context.created[0]!.wsHandler!({ url: () => 'wss://example.com/chat', close, connectToServer });
    expect(connectToServer).toHaveBeenCalledTimes(1);
    expect(browser.context.created[0]!.navigations).toEqual([]);
  });

  it('blocks a popup first request through its opener while leaving manual page traffic unchanged', async () => {
    const { open, engine, browser } = fixture(); const a = await open();
    const popup = new FakePage(); popup.parent = browser.context.created[0]!;
    const abort = vi.fn(async () => {}); const proceed = vi.fn(async () => {});
    const route = (page: FakePage, url: string) => ({ request: () => ({ url: () => url, frame: () => ({ page: () => page }) }), abort, continue: proceed });
    // No popup event has run yet: the initial request is still attributed through opener().
    await browser.context.routeHandler!(route(popup, 'http://localhost:55173/mcp'));
    expect(abort).toHaveBeenCalledTimes(1); expect(proceed).not.toHaveBeenCalled();
    await browser.context.routeHandler!(route(browser.context.manual, 'http://localhost:55173/mcp'));
    expect(proceed).toHaveBeenCalledTimes(1);
    await browser.context.routeHandler!(route(popup, 'https://example.com/popup'));
    expect(proceed).toHaveBeenCalledTimes(2);
    await request(engine, a, 'close');
    await browser.context.routeHandler!(route(popup, 'https://example.com/late-popup'));
    expect(abort).toHaveBeenCalledTimes(2);
  });

  it('sanitizes browser errors and rejects unsupported APIs', async () => {
    const { open, engine, browser } = fixture(); const a = await open();
    browser.context.screenshotError = new Error('secret API key; ws://127.0.0.1:9333/private');
    const before = browser.context.cdpDetachCount;
    await expect(request(engine, a, 'screenshot', { tabId: tabId(a) })).rejects.toMatchObject({ code: 'BROWSER_OPERATION_FAILED', message: 'The browser operation failed. Take a fresh snapshot or check the session status.' });
    expect(browser.context.cdpDetachCount).toBe(before + 1);
    for (const method of ['evaluate', 'cookies', 'upload', 'profile_create', 'connect']) await expect(request(engine, a, method)).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' });
    await expect(request(engine, a, 'new_tab', { profileId: 'other' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(request(engine, a, 'navigate', { tabId: tabId(a), url: 'https://example.com', endpoint: 'ws://somewhere' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('refuses a provider that resolves another profile', async () => {
    const { open, provider, connect } = fixture(); provider.connectInfo.mockResolvedValueOnce({ profileId: 'another', name: 'Other', cdpEndpoint: 'http://127.0.0.1:9333' });
    await expect(open()).rejects.toMatchObject({ code: 'PROFILE_MISMATCH' }); expect(connect).not.toHaveBeenCalled();
  });

  it('does not create a late session when shutdown races a reused connection', async () => {
    const { open, engine, browser } = fixture(); await open();
    const pending = open(); const stopped = engine.shutdown();
    await expect(pending).rejects.toMatchObject({ code: 'ROUTER_STOPPING' });
    await stopped;
    expect(browser.context.created).toHaveLength(1);
    expect(browser.context.created[0]!.closed).toBe(true);
    expect(browser.context.manual.closed).toBe(false);
  });

  it('reports incomplete shutdown until late page creation and cleanup have settled', async () => {
    const { open, engine, browser } = fixture({ operationTimeoutMs: 25 });
    let release!: () => void;
    browser.context.newPageGate = new Promise<void>(resolve => { release = resolve; });
    const opening = open().catch(error => error);
    await new Promise(resolve => setImmediate(resolve));
    await expect(engine.shutdown()).rejects.toMatchObject({ code: 'SHUTDOWN_INCOMPLETE' });
    expect(await opening).toBeInstanceOf(Error);
    release(); await new Promise(resolve => setImmediate(resolve));
    expect(browser.context.created[0]!.closed).toBe(true);
    await expect(engine.shutdown()).resolves.toBeUndefined();
    expect(browser.context.manual.closed).toBe(false);
  });

  it('keeps cleanup and status available after shutdown cannot close a live owned tab', async () => {
    const { open, engine, browser } = fixture(); const a = await open();
    const page = browser.context.created[0]!; const normalClose = page.close.bind(page);
    page.close = async () => { throw new Error('browser close failed'); };
    await expect(engine.shutdown()).rejects.toMatchObject({ code: 'CLOSE_FAILED' });
    expect(await request(engine, a, 'status')).toMatchObject({ status: 'paused' });
    await expect(open()).rejects.toMatchObject({ code: 'ROUTER_STOPPING' });
    page.close = normalClose;
    await expect(request(engine, a, 'close')).resolves.toMatchObject({ status: 'closed' });
    await expect(engine.shutdown()).resolves.toBeUndefined();
  });
});

describe('client-bound profile routing', () => {
  it('single-flights per alias: Claude CLI and Desktop share Claude, while Codex has its own browser', async () => {
    const { engine, open, browsers, providers, providerFor, connect } = multiProfileFixture();
    const [codex, secondCodex, cli, desktop] = await Promise.all([open('codex'), open('codex'), open('claude-cli'), open('claude-desktop')]);
    expect(providerFor).toHaveBeenCalledTimes(2);
    expect(providers.codex.connectInfo).toHaveBeenCalledTimes(1);
    expect(providers.claude.connectInfo).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(browsers.codex.context.created).toHaveLength(2);
    expect(browsers.claude.context.created).toHaveLength(2);
    expect(codex).toMatchObject({ clientId: 'codex', profileAlias: 'codex', profileId: CODEX_PROFILE_ID });
    expect(cli).toMatchObject({ clientId: 'claude-cli', profileAlias: 'claude', profileId: CLAUDE_PROFILE_ID });
    expect(desktop).toMatchObject({ clientId: 'claude-desktop', profileAlias: 'claude', profileId: CLAUDE_PROFILE_ID });
    expect(new Set([tabId(codex), tabId(secondCodex), tabId(cli), tabId(desktop)]).size).toBe(4);
    await request(engine, cli, 'close');
    expect((await request(engine, desktop, 'status'))).toMatchObject({ status: 'active' });
    expect(browsers.codex.context.created.every(page => !page.closed)).toBe(true);
  });

  it('rejects a capability presented by another bound client, including the other Claude client', async () => {
    const { engine, open } = multiProfileFixture();
    const cli = await open('claude-cli');
    for (const clientId of ['codex', 'claude-desktop'] as const) {
      await expect(engine.call({ method: 'status', clientId, sessionId: cli.sessionId, capability: cli.capability })).rejects.toMatchObject({ code: 'INVALID_SESSION' });
    }
    await expect(engine.call({ method: 'close', sessionId: cli.sessionId, capability: cli.capability })).rejects.toMatchObject({ code: 'INVALID_SESSION' });
    expect(await request(engine, cli, 'status')).toMatchObject({ clientId: 'claude-cli', status: 'active' });
    for (const override of [{ profileAlias: 'codex' }, { clientId: 'codex' }, { profileId: CODEX_PROFILE_ID }]) {
      await expect(engine.call({ method: 'open', clientId: 'claude-cli', params: { mode: 'mcp', ...override } })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    }
  });

  it('keeps equal CDP target IDs scoped to their own profile connection', async () => {
    const { engine, open, callbacks } = multiProfileFixture();
    const codex = await open('codex'); const claude = await open('claude-cli');
    const codexHandlers = callbacks.get('codex')!; const claudeHandlers = callbacks.get('claude')!;
    // Both fake browsers deliberately return target ID fake-0 for their first owned page.
    const codexOwner = codexHandlers.ownerForTarget('fake-0')!;
    const claudeOwner = claudeHandlers.ownerForTarget('fake-0')!;
    expect(codexOwner).not.toBe(claudeOwner);
    codexHandlers.registerOwnedTarget('same-popup-id', codexOwner);
    expect(claudeHandlers.ownerForTarget('same-popup-id')).toBeUndefined();
    claudeHandlers.registerOwnedTarget('same-popup-id', claudeOwner);
    await request(engine, codex, 'close');
    expect(codexHandlers.ownerForTarget('same-popup-id')!.isActive()).toBe(false);
    expect(claudeHandlers.ownerForTarget('same-popup-id')!.isActive()).toBe(true);
    expect(await request(engine, claude, 'status')).toMatchObject({ status: 'active' });
  });

  it('disconnects and reconnects only the affected profile, and protects every connected control port', async () => {
    const { engine, open, browsers, providers } = multiProfileFixture();
    const codex = await open('codex'); const claude = await open('claude-desktop');
    await expect(request(engine, claude, 'navigate', { tabId: tabId(claude), url: 'http://localhost:9333/json' })).rejects.toMatchObject({ code: 'NAVIGATION_BLOCKED' });
    await expect(request(engine, codex, 'navigate', { tabId: tabId(codex), url: 'http://localhost:9444/json' })).rejects.toMatchObject({ code: 'NAVIGATION_BLOCKED' });
    browsers.codex.disconnect();
    expect(await request(engine, codex, 'status')).toMatchObject({ status: 'disconnected' });
    await expect(request(engine, claude, 'navigate', { tabId: tabId(claude), url: 'https://example.com' })).resolves.toMatchObject({ tabId: tabId(claude) });
    browsers.codex = new FakeBrowser();
    const reopened = await open('codex');
    expect(reopened.profileId).toBe(CODEX_PROFILE_ID);
    expect(providers.codex.connectInfo).toHaveBeenCalledTimes(2);
    expect(providers.claude.connectInfo).toHaveBeenCalledTimes(1);
  });

  it('closes owned pages and popup guards in every profile while preserving both manual pages', async () => {
    const { engine, open, browsers, guards } = multiProfileFixture();
    await Promise.all([open('codex'), open('claude-cli'), open('claude-desktop')]);
    await engine.shutdown();
    for (const alias of ['codex', 'claude'] as const) {
      expect(browsers[alias].context.created.every(page => page.closed)).toBe(true);
      expect(browsers[alias].context.manual.closed).toBe(false);
      expect(guards[alias].close).toHaveBeenCalledTimes(1);
      expect(browsers[alias].isConnected()).toBe(true);
    }
  });

  it('publishes the resolved actual ID for a name-only profile binding', async () => {
    const { open } = fixture({ profiles: { codex: { name: 'codex' }, claude: { name: 'claude' } } });
    expect(await open()).toMatchObject({ profileAlias: 'codex', profileId: CODEX_PROFILE_ID, clientId: 'codex' });
  });
});
