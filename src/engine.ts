import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type CDPSession, type ElementHandle, type Page, type Request } from 'playwright-core';
import { MultiZenProvider } from './multizen.js';
import { KeelError, parseClientId, profileForClient, type ClientId, type ProfileAlias, type KeelConfig, type OpenResult, type PublicSession, type RouterEngine, type RpcRequest } from './contracts.js';
import { UrlPolicy } from './url-policy.js';
import { installPopupGuard, type PopupGuard, type PopupOwner } from './popup-guard.js';

interface Connection {
  readonly profileAlias: ProfileAlias; readonly profileId: string;
  browser: Browser; context: BrowserContext; name: string; popupGuard: PopupGuard;
  targetOwners: Map<string, Session>;
}
interface Ref { handle: ElementHandle; generation: number }
interface Tab { id: string; page: Page; generation: number; refs: Map<string, Ref> }
interface Session extends PopupOwner {
  id: string; capability: string; mode: 'cli' | 'mcp'; status: PublicSession['status'];
  readonly clientId: ClientId; readonly profileAlias: ProfileAlias; readonly profileId: string;
  connection: Connection; tabs: Map<string, Tab>; seenAt: number; queue: Promise<void>;
  inFlight?: Promise<unknown>; closingPromise?: Promise<PublicSession>;
}
interface Provider { connectInfo(): Promise<{ profileId: string; name: string; cdpEndpoint: string }> }
export interface EngineDependencies {
  provider?: Provider;
  providerFor?: (profileAlias: ProfileAlias) => Provider;
  connect?: (endpoint: string) => Promise<Browser>;
  installPopupGuard?: typeof installPopupGuard;
  now?: () => number;
}

const METHODS = new Set(['status', 'close', 'heartbeat', 'tabs', 'new_tab', 'close_tab', 'navigate', 'snapshot', 'click', 'fill', 'press', 'scroll', 'screenshot']);
const PARAMS: Record<string, readonly string[]> = {
  open: ['mode', 'url'], status: [], close: [], heartbeat: [], tabs: [], new_tab: ['url'], close_tab: ['tabId'],
  navigate: ['tabId', 'url'], snapshot: ['tabId'], click: ['tabId', 'ref'], fill: ['tabId', 'ref', 'text'],
  press: ['tabId', 'ref', 'key'], scroll: ['tabId', 'direction', 'amount', 'x', 'y'], screenshot: ['tabId'],
};
const ELEMENT_LIMIT = 200;
const TEXT_LIMIT = 16_000;

function requiredString(params: Record<string, unknown>, key: string, max = 16_384): string {
  const value = params[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new KeelError('INVALID_PARAMS', `A valid ${key} is required.`);
  return value;
}
function sanitized(error: unknown): KeelError {
  return error instanceof KeelError ? error : new KeelError('BROWSER_OPERATION_FAILED', 'The browser operation failed. Take a fresh snapshot or check the session status.');
}
function deadline<T>(work: Promise<T>, timeout: number, onTimeout?: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { onTimeout?.(); reject(new KeelError('OPERATION_TIMEOUT', 'The operation timed out. This session is paused; close it before opening a new session.')); }, timeout);
    work.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

/** The shared profile is trusted. Page routing is a guardrail, not a network sandbox. */
export function createEngine(config: KeelConfig, dependencies: EngineDependencies = {}): RouterEngine {
  const providers = new Map<ProfileAlias, Provider>();
  const connect = dependencies.connect ?? (endpoint => chromium.connectOverCDP(endpoint, { timeout: config.operationTimeoutMs }));
  const now = dependencies.now ?? Date.now;
  const policy = new UrlPolicy(config.mcpUrl);
  const sessions = new Map<string, Session>();
  const owners = new WeakMap<Page, Session>();
  const guards = new Set<PopupGuard>();
  const networkGuards = new WeakMap<Page, Promise<void>>();
  const pendingTabs = new Set<Promise<Tab>>();
  const connections = new Map<ProfileAlias, Connection>();
  const connecting = new Map<ProfileAlias, Promise<Connection>>();
  let stopping = false;

  function releaseRefs(tab: Tab): void {
    for (const ref of tab.refs.values()) void ref.handle.dispose().catch(() => {});
    tab.refs.clear();
  }
  function invalidate(connection: Connection): void {
    if (connections.get(connection.profileAlias) === connection) connections.delete(connection.profileAlias);
    for (const session of sessions.values()) if (session.connection === connection && session.status !== 'closed') {
      session.status = 'disconnected';
      for (const tab of session.tabs.values()) releaseRefs(tab);
    }
  }
  async function requestOwner(request: Request): Promise<{ owner: Session; page: Page } | undefined> {
    try {
      const target = request.frame().page();
      let page: Page | null = target;
      const visited = new Set<Page>();
      while (page && !visited.has(page)) {
        const owner = owners.get(page);
        if (owner) return { owner, page: target };
        visited.add(page);
        page = await page.opener();
      }
    } catch {
      // Service-worker requests have no frame. Do not change unowned/background traffic.
    }
    return undefined;
  }
  async function protectNetwork(context: BrowserContext, page: Page, owner: Session): Promise<void> {
    const existing = networkGuards.get(page);
    if (existing) return existing;
    const guard = (async () => {
      let client: CDPSession | undefined;
      try {
        client = await context.newCDPSession(page);
        const { targetInfo } = await client.send('Target.getTargetInfo');
        owner.connection.targetOwners.set(targetInfo.targetId, owner);
        const targetClient = client;
        targetClient.on('Fetch.requestPaused', event => {
          const allowed = owner.status === 'active' && policy.allowsRequest(event.request.url);
          const command = allowed
            ? targetClient.send('Fetch.continueRequest', { requestId: event.requestId })
            : targetClient.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
          void command.catch(() => {});
        });
        // Unlike Playwright's routing callback, CDP Fetch pauses every redirect hop,
        // including main-frame navigation. Network.setBlockedURLs alone does not.
        await targetClient.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
        page.once('close', () => { void client?.detach().catch(() => {}); });
      } catch {
        void client?.detach().catch(() => {});
        throw new KeelError('NETWORK_GUARD_FAILED', 'The browser control-endpoint guard could not be installed.');
      }
    })();
    networkGuards.set(page, guard);
    return guard;
  }
  async function connection(profileAlias: ProfileAlias): Promise<Connection> {
    const current = connections.get(profileAlias);
    if (current?.browser.isConnected() && current.popupGuard.isHealthy()) return current;
    const pending = connecting.get(profileAlias);
    if (pending) return pending;
    let provider = providers.get(profileAlias);
    if (!provider) {
      provider = dependencies.providerFor?.(profileAlias) ?? dependencies.provider ?? new MultiZenProvider(config, profileAlias);
      providers.set(profileAlias, provider);
    }
    const work = (async () => {
      const info = await provider.connectInfo();
      const pinnedId = config.profiles[profileAlias].id;
      if (!info.profileId || (pinnedId && info.profileId !== pinnedId)) throw new KeelError('PROFILE_MISMATCH', 'MultiZen returned a different profile.');
      policy.setCdpEndpoint(info.cdpEndpoint);
      const browser = await connect(info.cdpEndpoint);
      const context = browser.contexts()[0];
      if (!context || !browser.isConnected()) throw new KeelError('BROWSER_UNAVAILABLE', 'The profile has no connected default browser context.');
      let result: Connection | undefined;
      const targetOwners = new Map<string, Session>();
      const popupGuard = await (dependencies.installPopupGuard ?? installPopupGuard)(info.cdpEndpoint, {
        ownerForTarget: targetId => targetOwners.get(targetId),
        registerOwnedTarget: (targetId, owner) => { targetOwners.set(targetId, owner as Session); },
        allowsRequest: url => policy.allowsRequest(url),
        onFailure: () => {
          if (result) {
            invalidate(result);
            for (const session of sessions.values()) if (session.connection === result) void close(session).catch(() => {});
          }
        },
      }, config.operationTimeoutMs);
      guards.add(popupGuard);
      // Raw CDP auto-attach protects popups before their first frame exists. This
      // additional context route checks attribution when a frame is available and
      // leaves manual pages unchanged. Playwright disables this context's HTTP cache.
      await context.route('**/*', async route => {
        const attribution = await requestOwner(route.request());
        let allowed = !attribution || (attribution.owner.status === 'active' && policy.allowsRequest(route.request().url()));
        if (attribution && allowed) {
          try { await protectNetwork(context, attribution.page, attribution.owner); } catch { allowed = false; }
        }
        await (allowed ? route.continue() : route.abort('blockedbyclient')).catch(() => {});
      });
      result = { profileAlias, profileId: info.profileId, browser, context, name: info.name, popupGuard, targetOwners };
      const connected = result;
      browser.on('disconnected', () => { invalidate(connected); void popupGuard.close().catch(() => {}); });
      if (stopping) throw new KeelError('ROUTER_STOPPING', 'The router is stopping.');
      connections.set(profileAlias, connected);
      return connected;
    })();
    connecting.set(profileAlias, work);
    try { return await work; } finally { if (connecting.get(profileAlias) === work) connecting.delete(profileAlias); }
  }
  function active(session: Session): void {
    if (session.status !== 'active') throw new KeelError('SESSION_UNAVAILABLE', `The session is ${session.status}.`);
    if (!session.connection.browser.isConnected()) { invalidate(session.connection); throw new KeelError('SESSION_UNAVAILABLE', 'The session is disconnected.'); }
    if (!session.connection.popupGuard.isHealthy()) { invalidate(session.connection); throw new KeelError('SESSION_UNAVAILABLE', 'The popup guard is disconnected.'); }
  }
  function authenticate(request: RpcRequest): Session {
    const session = typeof request.sessionId === 'string' ? sessions.get(request.sessionId) : undefined;
    const actual = Buffer.from(typeof request.capability === 'string' ? request.capability : '');
    const expected = Buffer.from(session?.capability ?? '0'.repeat(64));
    const valid = actual.length === expected.length && timingSafeEqual(actual, expected);
    if (!session || !valid || session.clientId !== parseClientId(request.clientId)) throw new KeelError('INVALID_SESSION', 'The session credentials are invalid for this client.');
    session.seenAt = now();
    return session;
  }
  function publicUrl(page: Page): string {
    const url = page.url();
    if (url === 'about:blank') return url;
    try { return policy.assertNavigation(url); } catch { return '[blocked URL]'; }
  }
  function describe(session: Session): PublicSession {
    return { sessionId: session.id, clientId: session.clientId, profileAlias: session.profileAlias,
      profileId: session.profileId, profileName: session.connection.name, status: session.status,
      tabs: [...session.tabs.values()].filter(tab => !tab.page.isClosed()).map(tab => ({ tabId: tab.id, url: publicUrl(tab.page) })) };
  }
  function ownTab(session: Session, params: Record<string, unknown>): Tab {
    const tab = session.tabs.get(requiredString(params, 'tabId', 128));
    if (!tab || owners.get(tab.page) !== session || tab.page.isClosed()) throw new KeelError('INVALID_TAB', 'The tab is closed or does not belong to this session.');
    return tab;
  }
  async function registerPage(session: Session, page: Page): Promise<Tab> {
    const owner = owners.get(page);
    if (owner) {
      const existing = [...owner.tabs.values()].find(tab => tab.page === page);
      if (owner === session && existing) return existing;
      throw new KeelError('INVALID_TAB', 'The tab already belongs to another session.');
    }
    const tab: Tab = { id: randomUUID(), page, generation: 0, refs: new Map() };
    owners.set(page, session);
    session.tabs.set(tab.id, tab);
    page.on('close', () => { releaseRefs(tab); session.tabs.delete(tab.id); });
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) { tab.generation++; releaseRefs(tab); } });
    page.on('download', download => { void download.cancel().catch(() => {}); });
    page.on('popup', popup => {
      // This event supplies a verified opener relationship; unrelated context pages remain untouched.
      if (owners.has(popup)) return;
      if (session.status !== 'active') { void popup.close().catch(() => {}); return; }
      void registerPage(session, popup).catch(() => { void popup.close().catch(() => {}); });
    });
    try {
      await protectNetwork(session.connection.context, page, session);
      await page.route('**/*', route => {
        const action = session.status === 'active' && policy.allowsRequest(route.request().url()) ? route.continue() : route.abort('blockedbyclient');
        return action.catch(() => {});
      });
      await page.routeWebSocket('**/*', socket => {
        if (session.status === 'active' && policy.allowsWebSocket(socket.url())) socket.connectToServer();
        else return socket.close({ code: 1008, reason: 'Control endpoint blocked' }).catch(() => {});
      });
      active(session);
      return tab;
    } catch (error) {
      void page.close({ runBeforeUnload: false }).catch(() => {});
      throw error;
    }
  }
  async function createTab(session: Session, url?: string): Promise<Tab> {
    active(session);
    const normalized = url === undefined ? undefined : policy.assertNavigation(url);
    const page = await session.connection.context.newPage();
    if (session.status !== 'active' || stopping) {
      // Keep a failed late cleanup reachable by close/sweep/shutdown even though
      // the original open request already timed out and never returned a tab ID.
      const lateTab: Tab = { id: randomUUID(), page, generation: 0, refs: new Map() };
      owners.set(page, session); session.tabs.set(lateTab.id, lateTab);
      page.once('close', () => { session.tabs.delete(lateTab.id); });
      try { await page.close({ runBeforeUnload: false }); }
      catch { session.status = 'paused'; throw new KeelError('CLOSE_FAILED', 'A late-created session tab could not be closed. Retry stopping the router.'); }
      active(session); throw new KeelError('ROUTER_STOPPING', 'The router is stopping.');
    }
    try {
      const tab = await registerPage(session, page);
      if (normalized) await page.goto(normalized, { waitUntil: 'domcontentloaded', timeout: config.operationTimeoutMs });
      active(session);
      return tab;
    } catch (error) { await page.close({ runBeforeUnload: false }).catch(() => {}); throw error; }
  }
  async function newTab(session: Session, url?: string): Promise<Tab> {
    const work = createTab(session, url);
    pendingTabs.add(work);
    try { return await work; } finally { pendingTabs.delete(work); }
  }
  async function close(session: Session): Promise<PublicSession> {
    if (session.closingPromise) return session.closingPromise;
    if (session.status === 'closed') return describe(session);
    session.status = 'closing';
    const pending = closeOwned(session);
    session.closingPromise = pending;
    try { return await pending; } finally { session.closingPromise = undefined; }
  }
  async function closeOwned(session: Session): Promise<PublicSession> {
    // Refuse queued work immediately, allow already-running work a bounded time to settle,
    // then close owned pages to abort any remaining browser action.
    if (session.inFlight) await deadline(session.inFlight.then(() => {}, () => {}), Math.min(config.operationTimeoutMs, 1000)).catch(() => {});
    const tabs = [...session.tabs.values()];
    for (const tab of tabs) releaseRefs(tab);
    const results = await Promise.allSettled(tabs.map(tab => deadline(tab.page.close({ runBeforeUnload: false }), config.operationTimeoutMs)));
    for (const tab of tabs) if (tab.page.isClosed()) session.tabs.delete(tab.id);
    if (results.some(result => result.status === 'rejected') && session.tabs.size > 0 && session.connection.browser.isConnected()) {
      session.status = 'paused';
      throw new KeelError('CLOSE_FAILED', 'Some session tabs could not be closed. Retry closing this session.');
    }
    session.status = 'closed';
    return describe(session);
  }
  function enqueue<T>(session: Session, operation: () => Promise<T>): Promise<T> {
    const queuedAt = now();
    const result = session.queue.then(async () => {
      active(session);
      const remainingMs = config.operationTimeoutMs - (now() - queuedAt);
      if (remainingMs <= 0) throw new KeelError('QUEUE_TIMEOUT', 'The queued operation expired before it started. It was not performed.');
      const work = operation();
      session.inFlight = work;
      void work.then(() => { if (session.inFlight === work) session.inFlight = undefined; }, () => { if (session.inFlight === work) session.inFlight = undefined; });
      try {
        const value = await deadline(work, remainingMs, () => { if (session.status === 'active') session.status = 'paused'; });
        active(session);
        return value;
      }
      catch (error) { throw sanitized(error); }
    });
    session.queue = result.then(() => {}, () => {});
    return result;
  }
  async function reference(tab: Tab, params: Record<string, unknown>): Promise<ElementHandle> {
    const ref = tab.refs.get(requiredString(params, 'ref', 128));
    if (!ref || ref.generation !== tab.generation) throw new KeelError('STALE_REF', 'The element reference expired. Take a new snapshot.');
    const usable = await ref.handle.evaluate(element => element.isConnected && !((element as Element).tagName === 'INPUT' && (element as HTMLInputElement).type === 'file')).catch(() => false);
    if (!usable) throw new KeelError('STALE_REF', 'The element is detached or unavailable. Take a new snapshot.');
    return ref.handle;
  }
  async function snapshot(session: Session, tab: Tab): Promise<unknown> {
    releaseRefs(tab);
    const generation = tab.generation;
    const handles = await tab.page.$$('a,button,input:not([type="file"]),textarea,select,[role],[tabindex],[contenteditable="true"]');
    const elements: Array<Record<string, unknown>> = [];
    try {
      for (const handle of handles) {
        if (elements.length >= ELEMENT_LIMIT) break;
        const info = await handle.evaluate(element => {
          const node = element as HTMLElement;
          const style = getComputedStyle(node);
          if (!node.isConnected || node.getClientRects().length === 0 || style.visibility === 'hidden' || style.display === 'none') return null;
          const tag = node.tagName.toLowerCase();
          const editable = node.matches('input,textarea,[contenteditable]:not([contenteditable="false"])');
          const copy = node.cloneNode(true) as HTMLElement;
          for (const hidden of copy.querySelectorAll('input,textarea,[contenteditable],script,style')) hidden.remove();
          const inputType = tag === 'input' ? (node as HTMLInputElement).type : undefined;
          const role = node.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag === 'select' ? 'combobox' : editable ? 'textbox' : tag);
          const label = (node.getAttribute('aria-label') || node.getAttribute('title') || '') .slice(0, 300);
          return { tag, role, label, text: editable ? '[value hidden]' : (copy.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500),
            ...(inputType ? { inputType } : {}), disabled: node.matches(':disabled') || node.getAttribute('aria-disabled') === 'true' };
        }).catch(() => null);
        if (!info) continue;
        const ref = randomUUID();
        elements.push({ ref, ...info });
        tab.refs.set(ref, { handle, generation });
      }
      const body = await tab.page.evaluate((limit: number) => {
        const root = document.body;
        if (!root) return { text: '', truncated: false };
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const pieces: string[] = [];
        let count = 0;
        let truncated = false;
        while (walker.nextNode()) {
          const parent = walker.currentNode.parentElement;
          if (!parent || parent.closest('input,textarea,[contenteditable],script,style,noscript,template') || parent.getClientRects().length === 0) continue;
          const text = (walker.currentNode.textContent || '').replace(/\s+/g, ' ').trim();
          if (!text) continue;
          pieces.push(text); count += text.length + 1;
          if (count > limit) { truncated = true; break; }
        }
        return { text: pieces.join('\n').slice(0, limit), truncated };
      }, TEXT_LIMIT);
      active(session);
      if (generation !== tab.generation || tab.page.isClosed()) throw new KeelError('STALE_SNAPSHOT', 'The page changed while taking a snapshot. Try again.');
      return { tabId: tab.id, url: publicUrl(tab.page), title: await tab.page.title(), elements, text: body.text, truncated: body.truncated || elements.length === ELEMENT_LIMIT };
    } finally {
      if (session.status !== 'active' || generation !== tab.generation || tab.page.isClosed()) releaseRefs(tab);
      const retained = new Set([...tab.refs.values()].map(ref => ref.handle));
      for (const handle of handles) if (!retained.has(handle)) void handle.dispose().catch(() => {});
    }
  }
  async function action(session: Session, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'new_tab') {
      const url = params.url === undefined ? undefined : requiredString(params, 'url');
      const tab = await newTab(session, url);
      return { tabId: tab.id, url: publicUrl(tab.page) };
    }
    const tab = ownTab(session, params);
    if (method === 'close_tab') {
      await tab.page.close({ runBeforeUnload: false });
      return { tabId: tab.id, closed: true };
    }
    if (method === 'navigate') {
      const url = policy.assertNavigation(requiredString(params, 'url'));
      // Invalidate before goto, including navigations that fail before a frame event.
      tab.generation++; releaseRefs(tab);
      try {
        await tab.page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.operationTimeoutMs });
      } catch (error) {
        // Chromium schedules its internal error document after rejecting goto.
        // Wait for that document so it cannot interrupt the next permitted action.
        if (error instanceof Error && error.message.includes('ERR_BLOCKED_BY_CLIENT')) {
          await tab.page.waitForURL(value => value.protocol === 'chrome-error:', {
            waitUntil: 'domcontentloaded', timeout: Math.min(config.operationTimeoutMs, 1000),
          }).catch(() => {});
        }
        throw error;
      }
      return { tabId: tab.id, url: publicUrl(tab.page) };
    }
    if (method === 'snapshot') return snapshot(session, tab);
    if (method === 'screenshot') {
      const client = await session.connection.context.newCDPSession(tab.page);
      try {
        active(session);
        // Capture this owned target's current compositor surface directly, without
        // Playwright's extra font/animation preparation or a change to tab focus.
        const { data } = await client.send('Page.captureScreenshot', {
          format: 'png', fromSurface: true, captureBeyondViewport: false,
        });
        return { mimeType: 'image/png', data };
      } finally { await client.detach().catch(() => {}); }
    }
    if (method === 'scroll') {
      let x = 0; let y = 0;
      if (params.direction !== undefined) {
        const amount = params.amount ?? 600;
        if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1 || amount > 10000) throw new KeelError('INVALID_PARAMS', 'Scroll amount must be an integer from 1 to 10000.');
        switch (params.direction) { case 'up': y = -amount; break; case 'down': y = amount; break; case 'left': x = -amount; break; case 'right': x = amount; break; default: throw new KeelError('INVALID_PARAMS', 'A valid scroll direction is required.'); }
      } else {
        const rawX = params.x ?? 0; const rawY = params.y ?? 600;
        if (typeof rawX !== 'number' || typeof rawY !== 'number' || !Number.isInteger(rawX) || !Number.isInteger(rawY) || Math.abs(rawX) > 10000 || Math.abs(rawY) > 10000) throw new KeelError('INVALID_PARAMS', 'Scroll offsets must be bounded integers.');
        x = rawX; y = rawY;
      }
      await tab.page.mouse.wheel(x, y);
      return { tabId: tab.id, scrolled: true };
    }
    const handle = await reference(tab, params);
    active(session);
    if (method === 'click') await handle.click({ timeout: config.operationTimeoutMs });
    else if (method === 'fill') {
      if (typeof params.text !== 'string' || params.text.length > 100_000) throw new KeelError('INVALID_PARAMS', 'Fill text must be a string of at most 100000 characters.');
      await handle.fill(params.text, { timeout: config.operationTimeoutMs });
    } else if (method === 'press') await handle.press(requiredString(params, 'key', 100), { timeout: config.operationTimeoutMs });
    else throw new KeelError('METHOD_NOT_FOUND', 'The browser method is not supported.');
    return { tabId: tab.id, performed: method };
  }
  return {
    setBrokerPort(port) { policy.setBrokerPort(port); },
    async call(request) {
      try {
        if (!request || typeof request !== 'object' || typeof request.method !== 'string') throw new KeelError('INVALID_REQUEST', 'A browser method is required.');
        if (stopping && request.method !== 'close' && request.method !== 'status') throw new KeelError('ROUTER_STOPPING', 'The router is stopping. Only session status and cleanup are available.');
        const params = request.params ?? {};
        if (!params || typeof params !== 'object' || Array.isArray(params)) throw new KeelError('INVALID_PARAMS', 'Parameters must be an object.');
        const allowed = PARAMS[request.method];
        if (allowed && Object.keys(params).some(key => !allowed.includes(key))) throw new KeelError('INVALID_PARAMS', 'This operation contains unsupported parameters.');
        if (request.method === 'open') {
          if (params.mode !== 'cli' && params.mode !== 'mcp') throw new KeelError('INVALID_PARAMS', 'Session mode must be cli or mcp.');
          const url = params.url === undefined ? undefined : policy.assertNavigation(requiredString(params, 'url'));
          const clientId = parseClientId(request.clientId);
          const profileAlias = profileForClient(clientId);
          const connected = await connection(profileAlias);
          if (stopping) throw new KeelError('ROUTER_STOPPING', 'The router is stopping.');
          const session: Session = { id: randomUUID(), capability: randomBytes(32).toString('hex'), mode: params.mode,
            clientId, profileAlias, profileId: connected.profileId,
            status: 'active', connection: connected, tabs: new Map(), seenAt: now(), queue: Promise.resolve(),
            isActive() { return this.status === 'active'; } };
          sessions.set(session.id, session);
          try { await enqueue(session, () => newTab(session, url)); }
          catch (error) { await close(session).catch(() => {}); throw error; }
          return { ...describe(session), capability: session.capability } satisfies OpenResult;
        }
        if (!METHODS.has(request.method)) throw new KeelError('METHOD_NOT_FOUND', 'The browser method is not supported.');
        const session = authenticate(request);
        if (request.method === 'close') return close(session);
        if (request.method === 'status') return describe(session);
        if (request.method === 'heartbeat') { active(session); return { alive: true }; }
        if (request.method === 'tabs') { active(session); return describe(session).tabs; }
        active(session);
        return await enqueue(session, () => action(session, request.method, params));
      } catch (error) { throw sanitized(error); }
    },
    async sweep() {
      const expired = [...sessions.values()].filter(session => session.status !== 'closed' && now() - session.seenAt >= (session.mode === 'mcp' ? config.mcpLeaseMs : config.cliIdleMs));
      await Promise.allSettled(expired.map(close));
      for (const [id, session] of sessions) if (session.status === 'closed' && now() - session.seenAt >= config.cliIdleMs) sessions.delete(id);
    },
    async shutdown() {
      stopping = true;
      const results = await Promise.allSettled([...sessions.values()].filter(session => session.status !== 'closed').map(close));
      let incomplete = false;
      if (pendingTabs.size > 0) {
        try { await deadline(Promise.allSettled([...pendingTabs]), config.operationTimeoutMs); }
        catch { incomplete = true; }
      }
      if (incomplete || pendingTabs.size > 0) throw new KeelError('SHUTDOWN_INCOMPLETE', 'Browser cleanup is still pending. Retry stopping the router after outstanding page creation or close operations settle.');
      if (results.some(result => result.status === 'rejected') || [...sessions.values()].some(session => [...session.tabs.values()].some(tab => !tab.page.isClosed()))) {
        throw new KeelError('CLOSE_FAILED', 'Some owned browser tabs could not be closed. Retry closing the sessions or stopping the router.');
      }
      await Promise.all([...guards].map(guard => guard.close()));
      guards.clear();
      // Do not close the shared browser/context: MultiZen and all unowned tabs belong to the user.
    },
  };
}
